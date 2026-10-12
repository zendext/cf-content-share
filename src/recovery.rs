use crate::{auth, public, store};
use serde_json::Value;
use worker::*;

// Synchronization reads current D1 state after acquiring a lease; it never replays a payload.
pub async fn sync(env: &Env, id: &str, automatic: bool) -> Result<()> {
    let db = env.d1("DB")?;
    let now = store::now();
    let lease = auth::random_token()?;
    let Some(op) = db.prepare("UPDATE operations SET status='running', lease_token=?, lease_until=?, next_retry_at=?, retry_count=retry_count+?, total_attempts=total_attempts+CASE WHEN ?=0 AND type='resource.upload' THEN 0 ELSE 1 END, updated_at=? WHERE id=? AND retry_count<10 AND ((status IN ('pending','retry_pending') AND next_retry_at<=?) OR (status='running' AND lease_until<=?)) RETURNING *")
        .bind(&[lease.clone().into(), ((now+60) as f64).into(), ((now+60) as f64).into(), (i32::from(automatic) as f64).into(), (i32::from(automatic) as f64).into(), (now as f64).into(), id.into(), (now as f64).into(), (now as f64).into()])?
        .first::<store::Operation>(None).await? else { return Ok(()); };
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
    db.prepare("UPDATE operations SET kv_status=? WHERE id=? AND lease_token=?")
        .bind(&[
            (if kv_result.is_ok() {
                "accepted"
            } else {
                "failed"
            })
            .into(),
            id.into(),
            lease.clone().into(),
        ])?
        .run()
        .await?;
    let result = file_result.and(kv_result);
    let completed_at = store::now();
    if result.is_ok() {
        db.prepare("UPDATE operations SET status=CASE WHEN upload_state='needs_reupload' THEN 'needs_attention' ELSE 'completed' END, kv_status='accepted', next_retry_at=NULL, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=? AND lease_token=?")
            .bind(&[(completed_at as f64).into(), id.into(), lease.into()])?.run().await?;
    } else {
        let code = match result.err().unwrap().to_string().as_str() {
            "KV_SYNC_FAILED" => "KV_SYNC_FAILED",
            "UPLOAD_ACTIVE" => "UPLOAD_ACTIVE",
            "D1_PUBLISH_FAILED" => "D1_PUBLISH_FAILED",
            "OBJECT_OWNERSHIP_MISMATCH" => "OBJECT_OWNERSHIP_MISMATCH",
            _ => "R2_RECOVERY_FAILED",
        };
        let status = if op.retry_count >= 10 || code == "OBJECT_OWNERSHIP_MISMATCH" {
            "needs_attention"
        } else {
            "retry_pending"
        };
        let delay = (300 * (1_i64 << op.retry_count.min(4))).min(3600);
        let next: wasm_bindgen::JsValue = if status == "needs_attention" {
            wasm_bindgen::JsValue::NULL
        } else {
            ((completed_at + delay) as f64).into()
        };
        db.prepare("UPDATE operations SET status=?, r2_status=CASE WHEN ?='R2_RECOVERY_FAILED' THEN 'failed' ELSE r2_status END, kv_status=CASE WHEN ?='KV_SYNC_FAILED' THEN 'failed' ELSE kv_status END, error_code=?, next_retry_at=?, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=? AND lease_token=?")
            .bind(&[status.into(), code.into(), code.into(), code.into(), next, (completed_at as f64).into(), id.into(), lease.into()])?.run().await?;
        console_error!("{}", code);
    }
    Ok(())
}

pub async fn retry(env: &Env, id: &str) -> Result<Value> {
    // Manual retry only schedules work; Cron acquires execution and counts the new round.
    let now = store::now();
    env.d1("DB")?.prepare("UPDATE operations SET status='pending', retry_count=0, next_retry_at=?, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=? AND (status IN ('pending','retry_pending','needs_attention') OR (status='running' AND lease_until<=?))")
        .bind(&[(now as f64).into(), (now as f64).into(), id.into(), (now as f64).into()])?.run().await?;
    store::operation_result(env, id).await
}

pub async fn run(env: &Env) -> Result<()> {
    if expire(env).await.is_err() {
        console_error!("EXPIRATION_STORAGE_UNAVAILABLE");
    }
    let now = store::now();
    // Exhausted executions may have crashed after claiming the tenth attempt.
    env.d1("DB")?.prepare("UPDATE operations SET status='needs_attention', error_code=COALESCE(error_code,'EXECUTION_INTERRUPTED'), next_retry_at=NULL, lease_token=NULL, lease_until=NULL WHERE status='running' AND next_retry_at<=? AND retry_count>=10")
        .bind(&[(now as f64).into()])?.run().await?;
    let rows = env.d1("DB")?.prepare("SELECT id FROM operations WHERE status IN ('pending','retry_pending','running') AND next_retry_at<=? ORDER BY next_retry_at,id LIMIT 25")
        .bind(&[(now as f64).into()])?.all().await?.results::<Value>()?;
    for row in rows {
        if sync(env, row["id"].as_str().unwrap(), true).await.is_err() {
            console_error!("RECOVERY_STORAGE_UNAVAILABLE");
        }
    }
    Ok(())
}

async fn recover_file(env: &Env, op: &store::Operation, lease: &str) -> Result<()> {
    let mut resource = store::resource(env, &op.resource_id)
        .await?
        .ok_or_else(|| Error::RustError("missing resource".into()))?;
    if resource.state != "deleted" && resource.expired() {
        expire_resource(env, &resource.id).await?;
        resource = store::resource(env, &resource.id).await?.unwrap();
    }
    if resource.kind == "url" || op.r#type == "resource.update" {
        return Ok(());
    }
    if op.r#type == "resource.delete" {
        // A separate deletion task cannot terminate the current writer. Its upload
        // task owns fencing/verification; deletion waits until that durable step.
        if let Some(upload) = env
            .d1("DB")?
            .prepare("SELECT * FROM operations WHERE resource_id=? AND type='resource.upload'")
            .bind(&[resource.id.clone().into()])?
            .first::<store::Operation>(None)
            .await?
            && matches!(
                upload.upload_state.as_str(),
                "uploading" | "stored" | "failed"
            )
        {
            return Err(Error::RustError("UPLOAD_ACTIVE".into()));
        }
        return cleanup(env, op, lease, &resource).await;
    }
    if op.upload_state == "none" && resource.state == "deleted" {
        return cleanup(env, op, lease, &resource).await;
    }
    if op.upload_state == "none"
        || resource.accounting == "released"
        || resource.accounting == "published"
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
        db.batch(vec![
            db.prepare("UPDATE resources SET accounting='released' WHERE id=? AND accounting IN ('reserved','cleanup') AND EXISTS(SELECT 1 FROM operations WHERE id=? AND lease_token=?)").bind(&[resource.id.clone().into(),op.id.clone().into(),lease.into()])?,
            db.prepare("UPDATE operations SET upload_state='needs_reupload',r2_status='completed',error_code=COALESCE(error_code,'UPLOAD_REQUIRES_RETRANSMIT') WHERE id=? AND lease_token=?").bind(&[op.id.clone().into(),lease.into()])?
        ]).await?;
        return Ok(());
    }
    if object.size() != resource.size_bytes.unwrap()
        || object.checksum().sha256 != resource.sha256.as_ref().and_then(|s| hex::decode(s).ok())
    {
        return Err(Error::RustError("OBJECT_OWNERSHIP_MISMATCH".into()));
    }
    // A complete owned object proves this attempt's single writer has committed.
    db.batch(vec![
        db.prepare("UPDATE resources SET state='published',accounting='published' WHERE id=? AND state='pending' AND (expires_at IS NULL OR expires_at>unixepoch()) AND accounting='reserved' AND EXISTS(SELECT 1 FROM operations WHERE id=? AND lease_token=?)").bind(&[resource.id.clone().into(),op.id.clone().into(),lease.into()])?,
        db.prepare("UPDATE operations SET upload_state='none',r2_status='completed' WHERE id=? AND lease_token=?").bind(&[op.id.clone().into(),lease.into()])?
    ]).await.map_err(|_|Error::RustError("D1_PUBLISH_FAILED".into()))?;
    let mut resource = store::resource(env, &resource.id).await?.unwrap();
    resource.file_key = Some(attempt_key);
    if resource.state == "pending" && resource.expired() {
        expire_resource(env, &resource.id).await?;
        resource = store::resource(env, &resource.id).await?.unwrap();
    }
    if resource.state == "deleted" {
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
    if !matches!(resource.accounting.as_str(), "cleanup" | "reserved") {
        env.d1("DB")?
            .prepare("UPDATE operations SET r2_status='completed' WHERE id=? AND lease_token=?")
            .bind(&[op.id.clone().into(), lease.into()])?
            .run()
            .await?;
        return Ok(());
    }
    let bucket = env.bucket("FILES")?;
    let key = resource.file_key.as_ref().unwrap();
    bucket.delete(key).await?;
    if bucket.head(key).await?.is_some() {
        return Err(Error::RustError("delete not confirmed".into()));
    }
    env.d1("DB")?.batch(vec![
        env.d1("DB")?.prepare("UPDATE resources SET accounting='released' WHERE id=? AND state='deleted' AND accounting IN ('reserved','cleanup') AND EXISTS(SELECT 1 FROM operations WHERE id=? AND lease_token=?)").bind(&[resource.id.clone().into(),op.id.clone().into(),lease.into()])?,
        env.d1("DB")?.prepare("UPDATE operations SET r2_status='completed' WHERE id=? AND lease_token=?").bind(&[op.id.clone().into(),lease.into()])?
    ]).await?;
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
    db.batch(vec![
        db.prepare("UPDATE resources SET state='deleted',deleted_reason='expired',deleted_at=unixepoch(),target_url=NULL,description='',tags='[]',accounting=CASE WHEN accounting='published' THEN 'cleanup' ELSE accounting END WHERE id=? AND state IN ('pending','published') AND expires_at<=unixepoch()")
            .bind(&[id.into()])?,
        db.prepare("INSERT INTO operations(id,type,resource_id,fingerprint,created_at,updated_at,next_retry_at,r2_status) SELECT ?,'resource.delete',id,'expiration',unixepoch(),unixepoch(),unixepoch(),CASE WHEN kind='url' THEN 'none' ELSE 'pending' END FROM resources WHERE id=? AND changes()>0")
            .bind(&[operation_id.into(),id.into()])?,
    ]).await?;
    Ok(())
}
async fn expire(env: &Env) -> Result<()> {
    let rows = env.d1("DB")?.prepare("SELECT id FROM resources WHERE state IN ('pending','published') AND expires_at IS NOT NULL AND expires_at<=unixepoch() ORDER BY expires_at,id LIMIT 25")
        .all().await?.results::<Value>()?;
    for row in rows {
        if expire_resource(env, row["id"].as_str().unwrap())
            .await
            .is_err()
        {
            console_error!("EXPIRATION_RESOURCE_FAILED");
        }
    }
    Ok(())
}
