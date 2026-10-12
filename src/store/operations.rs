use super::{IdRow, Operation, OperationStatus};
use worker::*;

pub async fn get(db: &D1Database, id: &str) -> Result<Option<Operation>> {
    db.prepare("SELECT * FROM operations WHERE id=?")
        .bind(&[id.into()])?
        .first(None)
        .await
}

pub async fn claim_due_operation(
    db: &D1Database,
    id: &str,
    now: i64,
    lease: &str,
    automatic: bool,
) -> Result<Option<Operation>> {
    db.prepare(
        r#"
        UPDATE operations
        SET status='running',
            lease_token=?,
            lease_until=?,
            next_retry_at=?,
            retry_count=retry_count+?,
            total_attempts=total_attempts+CASE WHEN ?=0 AND type='resource.upload' THEN 0 ELSE 1 END,
            updated_at=?
        WHERE id=?
          AND retry_count<10
          AND ((status IN ('pending','retry_pending') AND next_retry_at<=?) OR (status='running' AND lease_until<=?))
        RETURNING *
        "#,
    )
    .bind(&[
        lease.into(),
        ((now + 60) as f64).into(),
        ((now + 60) as f64).into(),
        (i32::from(automatic) as f64).into(),
        (i32::from(automatic) as f64).into(),
        (now as f64).into(),
        id.into(),
        (now as f64).into(),
        (now as f64).into(),
    ])?
    .first::<Operation>(None)
    .await
}

pub async fn record_kv_result(
    db: &D1Database,
    id: &str,
    lease: &str,
    accepted: bool,
) -> Result<()> {
    db.prepare("UPDATE operations SET kv_status=? WHERE id=? AND lease_token=?")
        .bind(&[
            (if accepted { "accepted" } else { "failed" }).into(),
            id.into(),
            lease.into(),
        ])?
        .run()
        .await?;

    Ok(())
}

pub async fn complete_operation(db: &D1Database, id: &str, lease: &str, now: i64) -> Result<()> {
    db.prepare(
        r#"
        UPDATE operations
        SET status=CASE WHEN upload_state='needs_reupload' THEN 'needs_attention' ELSE 'completed' END,
            kv_status='accepted',
            next_retry_at=NULL,
            lease_token=NULL,
            lease_until=NULL,
            updated_at=?
        WHERE id=?
          AND lease_token=?
        "#,
    )
    .bind(&[(now as f64).into(), id.into(), lease.into()])?
    .run()
    .await?;

    Ok(())
}

pub async fn record_failure(
    db: &D1Database,
    id: &str,
    lease: &str,
    retry_count: i64,
    code: &str,
    now: i64,
) -> Result<()> {
    let status = if retry_count >= 10 || code == "OBJECT_OWNERSHIP_MISMATCH" {
        OperationStatus::NeedsAttention
    } else {
        OperationStatus::RetryPending
    };
    let delay = (300 * (1_i64 << retry_count.min(4))).min(3600);
    let next: wasm_bindgen::JsValue = if status == OperationStatus::NeedsAttention {
        wasm_bindgen::JsValue::NULL
    } else {
        ((now + delay) as f64).into()
    };
    db.prepare(
        r#"
        UPDATE operations
        SET status=?,
            r2_status=CASE WHEN ?='R2_RECOVERY_FAILED' THEN 'failed' ELSE r2_status END,
            kv_status=CASE WHEN ?='KV_SYNC_FAILED' THEN 'failed' ELSE kv_status END,
            error_code=?,
            next_retry_at=?,
            lease_token=NULL,
            lease_until=NULL,
            updated_at=?
        WHERE id=?
          AND lease_token=?
        "#,
    )
    .bind(&[
        status.as_str().into(),
        code.into(),
        code.into(),
        code.into(),
        next,
        (now as f64).into(),
        id.into(),
        lease.into(),
    ])?
    .run()
    .await?;

    Ok(())
}

pub async fn schedule_retry(db: &D1Database, id: &str, now: i64) -> Result<()> {
    db.prepare(
        r#"
        UPDATE operations
        SET status='pending',
            retry_count=0,
            next_retry_at=?,
            lease_token=NULL,
            lease_until=NULL,
            updated_at=?
        WHERE id=?
          AND (status IN ('pending','retry_pending','needs_attention') OR (status='running' AND lease_until<=?))
        "#,
    )
    .bind(&[
        (now as f64).into(),
        (now as f64).into(),
        id.into(),
        (now as f64).into(),
    ])?
    .run()
    .await?;

    Ok(())
}

pub async fn stop_exhausted_operations(db: &D1Database, now: i64) -> Result<()> {
    // Exhausted executions may have crashed after claiming the tenth attempt.
    db.prepare(
        r#"
        UPDATE operations
        SET status='needs_attention',
            error_code=COALESCE(error_code,'EXECUTION_INTERRUPTED'),
            next_retry_at=NULL,
            lease_token=NULL,
            lease_until=NULL
        WHERE status='running'
          AND next_retry_at<=?
          AND retry_count>=10
        "#,
    )
    .bind(&[(now as f64).into()])?
    .run()
    .await?;

    Ok(())
}

pub async fn list_due_operation_ids(db: &D1Database, now: i64) -> Result<Vec<String>> {
    let rows = db
        .prepare(
            r#"
        SELECT id
        FROM operations
        WHERE status IN ('pending','retry_pending','running')
          AND next_retry_at<=?
        ORDER BY next_retry_at,id
        LIMIT 25
        "#,
        )
        .bind(&[(now as f64).into()])?
        .all()
        .await?
        .results::<IdRow>()?;

    Ok(rows.into_iter().map(|row| row.id).collect())
}

pub async fn get_upload(db: &D1Database, resource_id: &str) -> Result<Option<Operation>> {
    db.prepare("SELECT * FROM operations WHERE resource_id=? AND type='resource.upload'")
        .bind(&[resource_id.into()])?
        .first::<Operation>(None)
        .await
}

pub async fn complete_cleanup(db: &D1Database, id: &str, lease: &str) -> Result<()> {
    db.prepare("UPDATE operations SET r2_status='completed' WHERE id=? AND lease_token=?")
        .bind(&[id.into(), lease.into()])?
        .run()
        .await?;

    Ok(())
}

pub async fn latest_for_resource(db: &D1Database, id: &str) -> Result<Option<Operation>> {
    db.prepare("SELECT * FROM operations WHERE resource_id=? ORDER BY sequence DESC LIMIT 1")
        .bind(&[id.into()])?
        .first::<Operation>(None)
        .await
}
