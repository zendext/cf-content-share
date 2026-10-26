use crate::{auth, catalog, json_response, recovery, sessions, store};
use futures_util::{
    Stream,
    future::{Either, select},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};
use worker::*;

// Workers runs one thread. Yield after every network chunk so multer cannot
// eagerly drain all ready chunks into its internal BytesMut before parsing.
struct Input {
    inner: send::SendWrapper<ByteStream>,
    pause: bool,
    framing_budget: Arc<AtomicUsize>,
}
impl Stream for Input {
    type Item = std::result::Result<Vec<u8>, std::io::Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.pause {
            self.pause = false;
            cx.waker().wake_by_ref();
            return Poll::Pending;
        }
        let result = Pin::new(&mut *self.inner).poll_next(cx);
        if result.is_ready() {
            self.pause = true;
        }
        result.map(|item| {
            item.map(|chunk| {
                let chunk =
                    chunk.map_err(|_| std::io::Error::other("request stream interrupted"))?;
                let budget = self.framing_budget.load(Ordering::Relaxed);
                if budget != usize::MAX {
                    let remaining = budget
                        .checked_sub(chunk.len())
                        .ok_or_else(|| std::io::Error::other("multipart framing too large"))?;
                    self.framing_budget.store(remaining, Ordering::Relaxed);
                }
                Ok(chunk)
            })
        })
    }
}

const UPLOAD_LEASE: i64 = 120;

pub async fn handle(req: &mut Request, env: &Env) -> Result<Response> {
    if req.path() == "/mcp/upload"
        && let Some(origin) = req.headers().get("Origin")?
        && origin != env.var("PUBLIC_ORIGIN")?.to_string()
    {
        return error("INVALID_ORIGIN", 403);
    }
    let authorized = if req.path() == "/mcp/upload" {
        auth::verify(req, env).await.is_ok()
    } else {
        sessions::authorized(req, env).await?
    };
    if !authorized {
        return error("UNAUTHORIZED", 401);
    }
    let content_type = req.headers().get("Content-Type")?.unwrap_or_default();
    let Ok(boundary) = multer::parse_boundary(&content_type) else {
        return error("INVALID_MULTIPART", 400);
    };
    if boundary.len() > 70 {
        return error("INVALID_MULTIPART", 400);
    }
    let framing_budget = Arc::new(AtomicUsize::new(256 * 1024));
    let input = Input {
        inner: send::SendWrapper::new(req.stream()?),
        pause: false,
        framing_budget: framing_budget.clone(),
    };
    let constraints = multer::Constraints::new()
        .allowed_fields(vec!["metadata", "file"])
        .size_limit(multer::SizeLimit::new().for_field("metadata", catalog::MAX_METADATA_BYTES));
    let mut multipart = multer::Multipart::with_constraints(input, boundary, constraints);
    let metadata = match multipart.next_field().await {
        Ok(Some(field)) if field.name() == Some("metadata") => match field.bytes().await {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok(),
            Err(_) => None,
        },
        _ => None,
    };
    let Some(mut metadata) = metadata.filter(|m| catalog::validate(&catalog::upload_schema(), m))
    else {
        return error("INVALID_METADATA", 400);
    };
    for key in ["title", "description"] {
        if metadata.get(key).is_none() {
            metadata[key] = json!("");
        }
    }
    if metadata.get("tags").is_none() {
        metadata["tags"] = json!([]);
    }
    let operation_id = metadata["operation_id"].as_str().unwrap().to_owned();
    let size = metadata["size_bytes"].as_u64().unwrap();
    let too_large = store::limit(env, "MAX_FILE_BYTES")?.is_some_and(|limit| size > limit);
    let (fingerprint, legacy_fingerprint) = store::creation_fingerprints(&mut metadata);
    let db = env.d1("DB")?;
    let token = auth::random_token()?;
    // One durable admission transaction reserves capacity and owns this upload attempt.
    for _ in 0..5 {
        if let Some(op) = store::operations::get(&env.d1("DB")?, &operation_id).await? {
            if op.r#type != store::OperationType::Upload
                || !(if op.fingerprint_version == 0 {
                    legacy_fingerprint.as_ref() == Some(&op.fingerprint)
                } else {
                    op.fingerprint == fingerprint
                })
            {
                return error("IDEMPOTENCY_CONFLICT", 409);
            }
            let resource = store::resources::get(&env.d1("DB")?, &op.resource_id)
                .await?
                .unwrap();
            if resource.state != store::ResourceState::Pending || resource.expired() {
                return json_response(&store::operation_result(env, &operation_id).await?, 200);
            }
            if op.upload_state != store::UploadState::NeedsReupload
                || (op.status == store::OperationStatus::Running
                    && op.lease_until.is_some_and(|until| until > store::now()))
            {
                return json_response(&store::operation_result(env, &operation_id).await?, 409);
            }
            if too_large {
                return error("FILE_TOO_LARGE", 413);
            }
            let now = store::now();
            let total = store::limit(env, "TOTAL_STORAGE_BYTES")?.unwrap_or(9_007_199_254_740_991);
            store::uploads::reserve_reupload(
                &db,
                &resource.id,
                total,
                &store::uploads::UploadAttempt {
                    operation_id: &operation_id,
                    token: &token,
                    now,
                    lease_until: now + UPLOAD_LEASE,
                },
            )
            .await?;
            break;
        }
        if too_large {
            return error("FILE_TOO_LARGE", 413);
        }
        if !store::valid_retention(&metadata) {
            return error("INVALID_METADATA", 400);
        }
        let id = store::resource_id()?;
        let now = store::now();
        let kind = if matches!(
            metadata["content_type"].as_str().unwrap(),
            "image/png"
                | "image/jpeg"
                | "image/gif"
                | "image/webp"
                | "image/avif"
                | "image/bmp"
                | "image/x-icon"
                | "image/svg+xml"
        ) {
            store::ResourceKind::Image
        } else {
            store::ResourceKind::File
        };
        let total = store::limit(env, "TOTAL_STORAGE_BYTES")?.unwrap_or(9_007_199_254_740_991);
        let result = store::uploads::reserve_new_upload(
            &db,
            &id,
            &metadata,
            kind,
            &fingerprint,
            total,
            &store::uploads::UploadAttempt {
                operation_id: &operation_id,
                token: &token,
                now,
                lease_until: now + UPLOAD_LEASE,
            },
        )
        .await;
        match result {
            Ok(_) => break,
            Err(e) => {
                if store::operations::get(&env.d1("DB")?, &operation_id)
                    .await?
                    .is_none()
                    && store::resources::get(&env.d1("DB")?, &id).await?.is_none()
                {
                    return Err(e);
                }
            }
        }
    }
    let Some(op) = store::operations::get(&env.d1("DB")?, &operation_id).await? else {
        return error("CAPACITY_EXCEEDED", 413);
    };
    if op.upload_token.as_deref() != Some(&token) {
        return if op.upload_state == store::UploadState::NeedsReupload {
            error("CAPACITY_EXCEEDED", 413)
        } else {
            json_response(&store::operation_result(env, &operation_id).await?, 409)
        };
    }
    let resource = store::resources::get(&env.d1("DB")?, &op.resource_id)
        .await?
        .unwrap();
    let abort = Arc::new(AtomicBool::new(false));
    let expected = hex::decode(metadata["sha256"].as_str().unwrap()).unwrap();
    let put = async {
        let mut file = match multipart.next_field().await {
            Ok(Some(field)) if field.name() == Some("file") => field,
            _ => return Err(Error::RustError("FILE_REQUIRED".into())),
        };
        framing_budget.store(usize::MAX, Ordering::Relaxed);
        // R2 may commit as soon as it receives the declared byte count, before
        // polling stream EOF. Validate framing before sending the final chunk;
        // an empty file must be completely validated before starting put().
        let file = if size == 0 {
            while let Some(chunk) = file
                .chunk()
                .await
                .map_err(|_| Error::RustError("invalid file stream".into()))?
            {
                if !chunk.is_empty() {
                    return Err(Error::RustError("file too long".into()));
                }
            }
            drop(file);
            ending(&mut multipart, &framing_budget).await?;
            None
        } else {
            Some(file)
        };
        let aborted = abort.clone();
        let stream = async_stream::try_stream! {
            if let Some(mut file)=file {
                let mut received=0u64;
                let mut last=None;
                while let Some(chunk)=file.chunk().await.map_err(|_|Error::RustError("invalid file stream".into()))? {
                    if aborted.load(Ordering::Relaxed){Err(Error::RustError("upload lease lost".into()))?;}
                    if chunk.is_empty(){continue;}
                    received+=chunk.len() as u64;
                    if received>size{Err(Error::RustError("file too long".into()))?;}
                    if received==size {last=Some(chunk.to_vec());} else {yield chunk.to_vec();}
                }
                if received!=size{Err(Error::RustError("file too short".into()))?;}
                drop(file);
                ending(&mut multipart,&framing_budget).await?;
                if aborted.load(Ordering::Relaxed){Err(Error::RustError("upload lease lost".into()))?;}
                if let Some(last)=last{yield last;}
            }
        };
        let bucket = env.bucket("FILES")?;
        let mut owner = HashMap::new();
        owner.insert("upload_token".into(), token.clone());
        owner.insert("operation_id".into(), operation_id.clone());
        bucket
            .put(
                resource.file_key.as_ref().unwrap(),
                FixedLengthStream::wrap(stream, size),
            )
            .sha256(expected.clone())
            .custom_metadata(owner)
            .only_if(Conditional {
                etag_does_not_match: Some("*".into()),
                ..Default::default()
            })
            .execute()
            .await
    };
    let heartbeat = async {
        loop {
            Delay::from(Duration::from_secs(30)).await;
            let now = store::now();
            let renewed = store::uploads::renew_upload_lease(
                &db,
                &operation_id,
                &token,
                now,
                now + UPLOAD_LEASE,
            )
            .await?;
            if !renewed {
                return Err::<(), Error>(Error::RustError("upload lease lost".into()));
            }
        }
    };
    futures_util::pin_mut!(put, heartbeat);
    let stored = match select(put, heartbeat).await {
        Either::Left((result, _)) => result,
        Either::Right((_, _)) => {
            abort.store(true, Ordering::Relaxed);
            Err(Error::RustError("upload heartbeat failed".into()))
        }
    };
    let successful = matches!(stored,Ok(Some(ref object)) if object.size()==size && object.checksum().sha256==Some(expected.clone()));
    finish_attempt(env, &operation_id, &token, successful).await?;
    let result = store::operation_result(env, &operation_id).await?;
    let status = if result["resource"]["state"] == "published" {
        201
    } else if successful {
        202
    } else {
        422
    };
    json_response(&result, status)
}

async fn finish_attempt(env: &Env, id: &str, token: &str, stored: bool) -> Result<()> {
    // The request's put settled (or heartbeat lost); recovery still fences before releasing.
    let now = store::now();
    store::uploads::finish_upload_attempt(&env.d1("DB")?, id, token, stored, now).await?;
    let _ = recovery::sync(env, id, false).await;
    Ok(())
}

async fn ending(multipart: &mut multer::Multipart<'_>, framing_budget: &AtomicUsize) -> Result<()> {
    framing_budget.store(256 * 1024, Ordering::Relaxed);
    if multipart
        .next_field()
        .await
        .map_err(|_| Error::RustError("invalid multipart ending".into()))?
        .is_some()
    {
        return Err(Error::RustError("extra multipart field".into()));
    }
    Ok(())
}

fn error(code: &str, status: u16) -> Result<Response> {
    let step = match code {
        "UNAUTHORIZED" => "authentication",
        "CAPACITY_EXCEEDED" => "capacity",
        "IDEMPOTENCY_CONFLICT" => "admission",
        _ => "validation",
    };
    json_response(&store::failure(code, step, false), status)
}
