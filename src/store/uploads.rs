use super::{IdRow, ResourceKind};
use serde_json::Value;
use worker::*;

pub struct UploadAttempt<'a> {
    pub operation_id: &'a str,
    pub token: &'a str,
    pub now: i64,
    pub lease_until: i64,
}

pub async fn release_fenced_upload(
    db: &D1Database,
    resource_id: &str,
    operation_id: &str,
    lease: &str,
) -> Result<()> {
    let resource_write = db
        .prepare(
            r#"
        UPDATE resources
        SET accounting='released'
        WHERE id=?
          AND accounting IN ('reserved','cleanup')
          AND EXISTS( SELECT 1 FROM operations WHERE id=? AND lease_token=?)
        "#,
        )
        .bind(&[resource_id.into(), operation_id.into(), lease.into()])?;
    let operation_write = db
        .prepare(
            r#"
        UPDATE operations
        SET upload_state='needs_reupload',
            r2_status='completed',
            error_code=COALESCE(error_code,'UPLOAD_REQUIRES_RETRANSMIT')
        WHERE id=?
          AND lease_token=?
        "#,
        )
        .bind(&[operation_id.into(), lease.into()])?;
    db.batch(vec![resource_write, operation_write]).await?;

    Ok(())
}

pub async fn publish_verified_upload(
    db: &D1Database,
    resource_id: &str,
    operation_id: &str,
    lease: &str,
) -> Result<()> {
    let resource_write = db
        .prepare(
            r#"
        UPDATE resources
        SET state='published',
            accounting='published'
        WHERE id=?
          AND state='pending'
          AND (expires_at IS NULL OR expires_at>unixepoch())
          AND accounting='reserved'
          AND EXISTS( SELECT 1 FROM operations WHERE id=? AND lease_token=?)
        "#,
        )
        .bind(&[resource_id.into(), operation_id.into(), lease.into()])?;
    let operation_write = db
        .prepare(
            r#"
        UPDATE operations
        SET upload_state='none',
            r2_status='completed'
        WHERE id=?
          AND lease_token=?
        "#,
        )
        .bind(&[operation_id.into(), lease.into()])?;
    db.batch(vec![resource_write, operation_write]).await?;

    Ok(())
}

pub async fn release_deleted_file(
    db: &D1Database,
    resource_id: &str,
    operation_id: &str,
    lease: &str,
) -> Result<()> {
    let resource_write = db
        .prepare(
            r#"
        UPDATE resources
        SET accounting='released'
        WHERE id=?
          AND state='deleted'
          AND accounting IN ('reserved','cleanup')
          AND EXISTS( SELECT 1 FROM operations WHERE id=? AND lease_token=?)
        "#,
        )
        .bind(&[resource_id.into(), operation_id.into(), lease.into()])?;
    let operation_write = db
        .prepare("UPDATE operations SET r2_status='completed' WHERE id=? AND lease_token=?")
        .bind(&[operation_id.into(), lease.into()])?;
    db.batch(vec![resource_write, operation_write]).await?;

    Ok(())
}

pub async fn reserve_reupload(
    db: &D1Database,
    resource_id: &str,
    total: u64,
    attempt: &UploadAttempt<'_>,
) -> Result<()> {
    let UploadAttempt {
        operation_id,
        token,
        now,
        lease_until,
    } = *attempt;
    let key = super::object_key(resource_id, token);
    let resource_write = db.prepare(
            r#"
        UPDATE resources
        SET accounting='reserved',
            file_key=?
        WHERE id=?
          AND state='pending'
          AND (expires_at IS NULL OR expires_at>unixepoch())
          AND accounting='released'
          AND ( SELECT published_bytes+reserved_bytes+cleanup_bytes FROM storage_usage WHERE id=1)<=?-size_bytes
          AND EXISTS( SELECT 1 FROM operations WHERE id=? AND upload_state='needs_reupload' AND (status!='running' OR lease_until<=?))
        "#,
        )
        .bind(&[
            key.into(),
            resource_id.into(),
            (total as f64).into(),
            operation_id.into(),
            (now as f64).into(),
        ])?;
    let operation_write = db
        .prepare(
            r#"
        UPDATE operations
        SET upload_state='uploading',
            upload_token=?,
            status='running',
            lease_token=?,
            lease_until=?,
            next_retry_at=?,
            updated_at=?,
            r2_status='pending',
            retry_count=0,
            total_attempts=total_attempts+1
        WHERE id=?
          AND changes()>0
        "#,
        )
        .bind(&[
            token.into(),
            token.into(),
            (lease_until as f64).into(),
            (lease_until as f64).into(),
            (now as f64).into(),
            operation_id.into(),
        ])?;
    db.batch(vec![resource_write, operation_write]).await?;

    Ok(())
}

pub async fn reserve_new_upload(
    db: &D1Database,
    resource_id: &str,
    metadata: &Value,
    kind: ResourceKind,
    fingerprint: &str,
    total: u64,
    attempt: &UploadAttempt<'_>,
) -> Result<()> {
    let UploadAttempt {
        operation_id,
        token,
        now,
        lease_until,
    } = *attempt;
    let id = resource_id;
    let size = metadata["size_bytes"].as_u64().unwrap();
    let resource_write = db.prepare(r#"
        INSERT INTO resources (
            id, kind, state, title, description, tags, created_at, file_key, filename,
            content_type, size_bytes, sha256, accounting, expiration_policy_version,
            retention_seconds)
        SELECT ?,?,'pending',?,?,?,?,?,?,?,?,?,'reserved',1,?
        WHERE ( SELECT published_bytes+reserved_bytes+cleanup_bytes FROM storage_usage WHERE id=1)<=?-?
        "#)
                .bind(&[id.into(),kind.as_str().into(),metadata["title"].as_str().unwrap().into(),metadata["description"].as_str().unwrap().into(),metadata["tags"].to_string().into(),(now as f64).into(),super::object_key(id,token).into(),metadata["filename"].as_str().unwrap().into(),metadata["content_type"].as_str().unwrap().into(),(size as f64).into(),metadata["sha256"].as_str().unwrap().into(),metadata["retention_seconds"].as_i64().map(|n| wasm_bindgen::JsValue::from(n as f64)).unwrap_or(wasm_bindgen::JsValue::NULL),(total as f64).into(),(size as f64).into()])?;
    let operation_write = db
        .prepare(
            r#"
        INSERT INTO operations (
            id, type, resource_id, fingerprint, status, created_at, updated_at, next_retry_at,
            lease_token, lease_until, upload_state, upload_token, r2_status, total_attempts,
            fingerprint_version)
        SELECT ?,'resource.upload',?,?,'running',?,?,?,?,?,'uploading',?,'pending',1,1
        WHERE changes()>0
        "#,
        )
        .bind(&[
            operation_id.into(),
            id.into(),
            fingerprint.into(),
            (now as f64).into(),
            (now as f64).into(),
            (lease_until as f64).into(),
            token.into(),
            (lease_until as f64).into(),
            token.into(),
        ])?;
    db.batch(vec![resource_write, operation_write]).await?;

    Ok(())
}

pub async fn renew_upload_lease(
    db: &D1Database,
    id: &str,
    token: &str,
    now: i64,
    lease_until: i64,
) -> Result<bool> {
    let renewed = db
        .prepare(
            r#"
        UPDATE operations
        SET lease_until=?,
            next_retry_at=?,
            updated_at=?
        WHERE id=?
          AND lease_token=?
          AND upload_token=?
          AND upload_state='uploading'
        RETURNING id
        "#,
        )
        .bind(&[
            (lease_until as f64).into(),
            (lease_until as f64).into(),
            (now as f64).into(),
            id.into(),
            token.into(),
            token.into(),
        ])?
        .first::<IdRow>(None)
        .await?;

    Ok(renewed.is_some())
}

pub async fn finish_upload_attempt(
    db: &D1Database,
    id: &str,
    token: &str,
    stored: bool,
    now: i64,
) -> Result<()> {
    db.prepare(
        r#"
        UPDATE operations
        SET upload_state=?,
            status='pending',
            lease_token=NULL,
            lease_until=NULL,
            next_retry_at=?,
            updated_at=?,
            error_code=COALESCE(?,error_code)
        WHERE id=?
          AND upload_token=?
          AND lease_token=?
        "#,
    )
    .bind(&[
        (if stored { "stored" } else { "failed" }).into(),
        (now as f64).into(),
        (now as f64).into(),
        if stored {
            wasm_bindgen::JsValue::NULL
        } else {
            "UPLOAD_STREAM_OR_CHECKSUM_FAILED".into()
        },
        id.into(),
        token.into(),
        token.into(),
    ])?
    .run()
    .await?;

    Ok(())
}
