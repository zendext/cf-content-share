use crate::{auth, public, store};
use serde_json::Value;
use worker::*;

// Synchronization reads current D1 state after acquiring a lease; it never replays a payload.
pub async fn sync(env: &Env, id: &str, automatic: bool) -> Result<()> {
    let db = env.d1("DB")?;
    let now = store::now();
    let lease = auth::random_token()?;
    let Some(op) = store::operations::claim_due_operation(&db, id, now, &lease, automatic).await?
    else {
        return Ok(());
    };
    let file_result = recover_file(env, &op, &lease).await;
    // Public deletion state must propagate even while R2 cleanup is blocked.
    let kv_result = async {
        let mapping = public::snapshot(env, &op.resource_id)
            .await?
            .ok_or_else(|| Error::RustError("operation resource missing".into()))?;
        public::write(env, &mapping)
            .await
            .map_err(|_| Error::RustError("KV_SYNC_FAILED".into()))
    }
    .await;
    store::operations::record_kv_result(&db, id, &lease, kv_result.is_ok()).await?;
    let result = file_result.and(kv_result);
    let completed_at = store::now();
    if result.is_ok() {
        store::operations::complete_operation(&db, id, &lease, completed_at).await?;
    } else {
        let code = match result.err().unwrap().to_string().as_str() {
            "KV_SYNC_FAILED" => "KV_SYNC_FAILED",
            "UPLOAD_ACTIVE" => "UPLOAD_ACTIVE",
            "D1_PUBLISH_FAILED" => "D1_PUBLISH_FAILED",
            "OBJECT_OWNERSHIP_MISMATCH" => "OBJECT_OWNERSHIP_MISMATCH",
            _ => "R2_RECOVERY_FAILED",
        };
        store::operations::record_failure(&db, id, &lease, op.retry_count, code, completed_at)
            .await?;
        console_error!("{}", code);
    }
    Ok(())
}

pub async fn retry(env: &Env, id: &str) -> Result<Value> {
    // Manual retry only schedules work; Cron acquires execution and counts the new round.
    let now = store::now();
    store::operations::schedule_retry(&env.d1("DB")?, id, now).await?;
    store::operation_result(env, id).await
}

pub async fn run(env: &Env) -> Result<()> {
    if expire(env).await.is_err() {
        console_error!("EXPIRATION_STORAGE_UNAVAILABLE");
    }
    let now = store::now();
    let db = env.d1("DB")?;
    store::operations::stop_exhausted_operations(&db, now).await?;
    let ids = store::operations::list_due_operation_ids(&db, now).await?;
    for id in ids {
        if sync(env, &id, true).await.is_err() {
            console_error!("RECOVERY_STORAGE_UNAVAILABLE");
        }
    }
    Ok(())
}

async fn recover_file(env: &Env, op: &store::Operation, lease: &str) -> Result<()> {
    let mut resource = store::resources::get(&env.d1("DB")?, &op.resource_id)
        .await?
        .ok_or_else(|| Error::RustError("missing resource".into()))?;
    if resource.state != store::ResourceState::Deleted && resource.expired() {
        expire_resource(env, &resource.id).await?;
        resource = store::resources::get(&env.d1("DB")?, &resource.id)
            .await?
            .unwrap();
    }
    if resource.kind == store::ResourceKind::Url || op.r#type == store::OperationType::Update {
        return Ok(());
    }
    if op.r#type == store::OperationType::Delete {
        // A separate deletion task cannot terminate the current writer. Its upload
        // task owns fencing/verification; deletion waits until that durable step.
        if let Some(upload) = store::operations::get_upload(&env.d1("DB")?, &resource.id).await?
            && matches!(
                upload.upload_state,
                store::UploadState::Uploading
                    | store::UploadState::Stored
                    | store::UploadState::Failed
            )
        {
            return Err(Error::RustError("UPLOAD_ACTIVE".into()));
        }
        return cleanup(env, op, lease, &resource).await;
    }
    if op.upload_state == store::UploadState::None
        && resource.state == store::ResourceState::Deleted
    {
        return cleanup(env, op, lease, &resource).await;
    }
    if op.upload_state == store::UploadState::None
        || resource.accounting == store::Accounting::Released
        || resource.accounting == store::Accounting::Published
    {
        return Ok(());
    }
    let bucket = env.bucket("FILES")?;
    let token = op.upload_token.as_ref().unwrap();
    let attempt_key = store::object_key(&op.resource_id, token);
    let key = &attempt_key;
    // Empty marker is permanent: deleting it could allow a previously stalled
    // create-only writer to commit after this reservation has been released.
    let mut marker = std::collections::HashMap::new();
    marker.insert("role".into(), "fence".into());
    marker.insert("upload_token".into(), token.clone());
    marker.insert("operation_id".into(), op.id.clone());
    bucket
        .put(key, Vec::<u8>::new())
        .custom_metadata(marker)
        .only_if(Conditional {
            etag_does_not_match: Some("*".into()),
            ..Default::default()
        })
        .execute()
        .await?;
    let object = bucket
        .head(key)
        .await?
        .ok_or_else(|| Error::RustError("missing fenced object".into()))?;
    let metadata = object.custom_metadata()?;
    if metadata.get("upload_token") != Some(token) || metadata.get("operation_id") != Some(&op.id) {
        return Err(Error::RustError("OBJECT_OWNERSHIP_MISMATCH".into()));
    }
    let fence = metadata.get("role").is_some_and(|role| role == "fence");
    let db = env.d1("DB")?;
    if fence {
        store::uploads::release_fenced_upload(&db, &resource.id, &op.id, lease).await?;
        return Ok(());
    }
    if object.size() != resource.size_bytes.unwrap()
        || object.checksum().sha256 != resource.sha256.as_ref().and_then(|s| hex::decode(s).ok())
    {
        return Err(Error::RustError("OBJECT_OWNERSHIP_MISMATCH".into()));
    }
    // A complete owned object proves this attempt's single writer has committed.
    store::uploads::publish_verified_upload(&db, &resource.id, &op.id, lease)
        .await
        .map_err(|_| Error::RustError("D1_PUBLISH_FAILED".into()))?;
    let mut resource = store::resources::get(&env.d1("DB")?, &resource.id)
        .await?
        .unwrap();
    resource.file_key = Some(attempt_key);
    if resource.state == store::ResourceState::Pending && resource.expired() {
        expire_resource(env, &resource.id).await?;
        resource = store::resources::get(&env.d1("DB")?, &resource.id)
            .await?
            .unwrap();
    }
    if resource.state == store::ResourceState::Deleted {
        cleanup(env, op, lease, &resource).await?;
    }
    Ok(())
}

async fn cleanup(
    env: &Env,
    op: &store::Operation,
    lease: &str,
    resource: &store::Resource,
) -> Result<()> {
    if !matches!(
        resource.accounting,
        store::Accounting::Cleanup | store::Accounting::Reserved
    ) {
        store::operations::complete_cleanup(&env.d1("DB")?, &op.id, lease).await?;
        return Ok(());
    }
    let bucket = env.bucket("FILES")?;
    let key = resource.file_key.as_ref().unwrap();
    bucket.delete(key).await?;
    if bucket.head(key).await?.is_some() {
        return Err(Error::RustError("delete not confirmed".into()));
    }
    store::uploads::release_deleted_file(&env.d1("DB")?, &resource.id, &op.id, lease).await?;
    // Cache eviction is best effort and local; authoritative state gates every read.
    let _ = Cache::default()
        .delete(
            format!("{}/r/{}", env.var("PUBLIC_ORIGIN")?, resource.id),
            true,
        )
        .await;
    Ok(())
}

// The condition is evaluated in the write transaction, not against the scan's snapshot.
async fn expire_resource(env: &Env, id: &str) -> Result<()> {
    let db = env.d1("DB")?;
    let operation_id = auth::random_token()?;
    store::resources::expire_if_due(&db, id, &operation_id).await?;
    Ok(())
}
async fn expire(env: &Env) -> Result<()> {
    let ids = store::resources::list_expired_ids(&env.d1("DB")?).await?;
    for id in ids {
        if expire_resource(env, &id).await.is_err() {
            console_error!("EXPIRATION_RESOURCE_FAILED");
        }
    }
    Ok(())
}
