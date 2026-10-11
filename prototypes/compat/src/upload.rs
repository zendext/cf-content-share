use crate::{auth, error, json_response};
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll},
};
use worker::*;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    operation_id: String,
    filename: String,
    content_type: String,
    size_bytes: u64,
    sha256: String,
}

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

pub async fn handle(req: &mut Request, env: &Env) -> Result<Response> {
    let authorization = req.headers().get("Authorization")?.unwrap_or_default();
    let Some(token) = authorization
        .strip_prefix("Bearer ")
        .filter(|t| t.len() == 43)
    else {
        return error("UNAUTHORIZED", 401);
    };
    let db = env.d1("DB")?;
    let now = (Date::now().as_millis() / 1000) as f64;
    let session = db
        .prepare("SELECT id FROM upload_sessions WHERE token_hash=? AND revoked=0 AND expires_at>?")
        .bind(&[
            hex::encode(Sha256::digest(token.as_bytes())).into(),
            now.into(),
        ])?
        .first::<Value>(None)
        .await?;
    if session.is_none() {
        return error("UNAUTHORIZED", 401);
    }
    let content_type = req.headers().get("Content-Type")?.unwrap_or_default();
    let Ok(boundary) = multer::parse_boundary(&content_type) else {
        return error("INVALID_MULTIPART", 400);
    };
    if boundary.len() > 70 {
        return error("INVALID_MULTIPART", 400);
    }
    let constraints = multer::Constraints::new()
        .allowed_fields(vec!["metadata", "file"])
        .size_limit(multer::SizeLimit::new().for_field("metadata", 16384));
    let framing_budget = Arc::new(AtomicUsize::new(256 * 1024));
    let input = Input {
        inner: send::SendWrapper::new(req.stream()?),
        pause: false,
        framing_budget: framing_budget.clone(),
    };
    let mut multipart = multer::Multipart::with_constraints(input, boundary, constraints);
    let metadata = match multipart.next_field().await {
        Ok(Some(field)) if field.name() == Some("metadata") => match field.bytes().await {
            Ok(bytes) => serde_json::from_slice::<Metadata>(&bytes).ok(),
            Err(_) => None,
        },
        _ => None,
    };
    let Some(metadata) = metadata else {
        return error("INVALID_METADATA", 400);
    };
    if metadata.operation_id.is_empty()
        || metadata.operation_id.len() > 128
        || metadata.filename.is_empty()
        || metadata.filename.len() > 1024
        || metadata.content_type.is_empty()
        || metadata.content_type.len() > 255
        || metadata.content_type.chars().any(char::is_control)
        || metadata.size_bytes > 9_007_199_254_740_991
        || metadata.sha256.len() != 64
        || !metadata
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return error("INVALID_METADATA", 400);
    }
    if let Ok(limit) = env.var("MAX_FILE_BYTES") {
        let limit: u64 = limit
            .to_string()
            .parse()
            .map_err(|_| Error::RustError("invalid limit".into()))?;
        if metadata.size_bytes > limit {
            return error("FILE_TOO_LARGE", 413);
        }
    }
    let mut file = match multipart.next_field().await {
        Ok(Some(field)) if field.name() == Some("file") => field,
        _ => return error("FILE_REQUIRED", 400),
    };
    framing_budget.store(usize::MAX, Ordering::Relaxed);
    let canonical = serde_json::to_string(&metadata)?;
    let id = auth::random_token()?; // Prototype object namespace; product IDs are a later implementation.
    db.prepare("INSERT OR IGNORE INTO uploads(operation_id,resource_id,metadata,state,size_bytes) VALUES(?,?,?,'pending',?)").bind(&[metadata.operation_id.clone().into(), id.clone().into(), canonical.clone().into(), (metadata.size_bytes as f64).into()])?.run().await?;
    let row = db
        .prepare("SELECT * FROM uploads WHERE operation_id=?")
        .bind(&[metadata.operation_id.clone().into()])?
        .first::<Value>(None)
        .await?
        .ok_or_else(|| Error::RustError("missing upload".into()))?;
    if row["metadata"] != canonical {
        return error("IDEMPOTENCY_CONFLICT", 409);
    }
    if row["resource_id"] != id {
        if row["state"] == "stored" {
            return json_response(
                &json!({"resource_id":row["resource_id"],"operation_id":metadata.operation_id,"state":"stored"}),
                200,
            );
        }
        return error("UPLOAD_PENDING_OR_FAILED", 409);
    }
    let size = metadata.size_bytes;
    let chunks = Arc::new(AtomicUsize::new(0));
    let max_chunk = Arc::new(AtomicUsize::new(0));
    let chunks_observed = chunks.clone();
    let max_observed = max_chunk.clone();
    let stream = async_stream::try_stream! {
        let mut received = 0_u64;
        while let Some(chunk) = file.chunk().await.map_err(|_| Error::RustError("invalid file stream".into()))? {
            received += chunk.len() as u64;
            if received > size { Err(Error::RustError("file too long".into()))?; }
            chunks_observed.fetch_add(1, Ordering::Relaxed);
            max_observed.fetch_max(chunk.len(), Ordering::Relaxed);
            yield chunk.to_vec();
        }
        if received != size { Err(Error::RustError("file too short".into()))?; }
        drop(file);
        framing_budget.store(256 * 1024, Ordering::Relaxed);
        if multipart.next_field().await.map_err(|_| Error::RustError("invalid multipart ending".into()))?.is_some() {
            Err(Error::RustError("extra multipart field".into()))?;
        }
    };
    let bucket = env.bucket("FILES")?;
    let key = format!("objects/{id}");
    let expected =
        hex::decode(&metadata.sha256).map_err(|_| Error::RustError("invalid digest".into()))?;
    let stored = bucket
        .put(&key, FixedLengthStream::wrap(stream, size))
        .sha256(expected.clone())
        .only_if(Conditional {
            etag_does_not_match: Some("*".into()),
            ..Default::default()
        })
        .execute()
        .await;
    match stored {
        Ok(Some(object)) if object.size() == size && object.checksum().sha256 == Some(expected) => {
            db.prepare("UPDATE uploads SET state='stored' WHERE operation_id=? AND resource_id=? AND state='pending'").bind(&[metadata.operation_id.clone().into(), id.clone().into()])?.run().await?;
            let memory: js_sys::WebAssembly::Memory = wasm_bindgen::memory().unchecked_into();
            let memory_bytes = js_sys::ArrayBuffer::from(memory.buffer()).byte_length();
            json_response(
                &json!({"operation_id":metadata.operation_id,"resource_id":id,"state":"stored","size_bytes":size,"sha256":metadata.sha256,"stream":{"chunks":chunks.load(Ordering::Relaxed),"max_chunk_bytes":max_chunk.load(Ordering::Relaxed),"wasm_memory_bytes":memory_bytes}}),
                201,
            )
        }
        Ok(None) => {
            // A failed create-only condition means the object belongs to someone
            // else. Never delete it as cleanup for this upload.
            db.prepare("UPDATE uploads SET state='failed' WHERE operation_id=? AND resource_id=?")
                .bind(&[metadata.operation_id.into(), id.into()])?
                .run()
                .await?;
            error("OBJECT_ALREADY_EXISTS", 409)
        }
        _ => {
            // A failure never publishes. If cleanup itself fails, keep pending for inspection.
            bucket.delete(&key).await?;
            db.prepare("UPDATE uploads SET state='failed' WHERE operation_id=? AND resource_id=?")
                .bind(&[metadata.operation_id.into(), id.into()])?
                .run()
                .await?;
            error("UPLOAD_STREAM_OR_CHECKSUM_FAILED", 422)
        }
    }
}

pub async fn read(id: &str, env: &Env) -> Result<Response> {
    let row = env
        .d1("DB")?
        .prepare("SELECT resource_id FROM uploads WHERE resource_id=? AND state='stored'")
        .bind(&[id.into()])?
        .first::<Value>(None)
        .await?;
    if row.is_none() {
        return error("NOT_FOUND", 404);
    }
    let Some(object) = env
        .bucket("FILES")?
        .get(format!("objects/{id}"))
        .execute()
        .await?
    else {
        return error("NOT_FOUND", 404);
    };
    let body = object
        .body()
        .ok_or_else(|| Error::RustError("missing body".into()))?;
    let mut response = Response::from_stream(body.stream()?)?;
    response
        .headers_mut()
        .set("Content-Type", "application/octet-stream")?;
    response
        .headers_mut()
        .set("Content-Disposition", "attachment")?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

use wasm_bindgen::JsCast;
