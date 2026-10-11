use crate::{auth, public, store};
use serde_json::Value;
use worker::*;

// Synchronization reads current D1 state after acquiring a lease; it never replays a payload.
pub async fn sync(env: &Env, id: &str, automatic: bool) -> Result<()> {
    let db = env.d1("DB")?;
    let now = store::now();
    let lease = auth::random_token()?;
    let Some(op) = db.prepare("UPDATE operations SET status='running', lease_token=?, lease_until=?, next_retry_at=?, retry_count=retry_count+?, total_attempts=total_attempts+1, updated_at=? WHERE id=? AND retry_count<10 AND ((status IN ('pending','retry_pending') AND next_retry_at<=?) OR (status='running' AND lease_until<=?)) RETURNING *")
        .bind(&[lease.clone().into(), ((now+60) as f64).into(), ((now+60) as f64).into(), (i32::from(automatic) as f64).into(), (now as f64).into(), id.into(), (now as f64).into(), (now as f64).into()])?
        .first::<store::Operation>(None).await? else { return Ok(()); };
    let result = async {
        let mapping = public::snapshot(env, &op.resource_id)
            .await?
            .ok_or_else(|| Error::RustError("operation resource missing".into()))?;
        public::write(env, &mapping).await
    }
    .await;
    let completed_at = store::now();
    if result.is_ok() {
        db.prepare("UPDATE operations SET status='completed', kv_status='accepted', next_retry_at=NULL, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=? AND lease_token=?")
            .bind(&[(completed_at as f64).into(), id.into(), lease.into()])?.run().await?;
    } else {
        let status = if op.retry_count >= 10 {
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
        db.prepare("UPDATE operations SET status=?, kv_status='failed', error_code='KV_SYNC_FAILED', next_retry_at=?, lease_token=NULL, lease_until=NULL, updated_at=? WHERE id=? AND lease_token=?")
            .bind(&[status.into(), next, (completed_at as f64).into(), id.into(), lease.into()])?.run().await?;
        console_error!("KV_SYNC_FAILED");
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
