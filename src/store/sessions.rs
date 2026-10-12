use serde_json::Value;
use worker::*;

pub async fn create(
    db: &D1Database,
    id: &str,
    token_hash: &str,
    now: i64,
    client: Option<&str>,
) -> Result<()> {
    db.prepare(
        "INSERT INTO upload_sessions(id,token_hash,created_at,expires_at,client) VALUES(?,?,?,?,?)",
    )
    .bind(&[
        id.into(),
        token_hash.into(),
        (now as f64).into(),
        ((now + 86400) as f64).into(),
        client
            .map(Into::into)
            .unwrap_or(wasm_bindgen::JsValue::NULL),
    ])?
    .run()
    .await?;

    Ok(())
}

pub async fn revoke(db: &D1Database, id: &str) -> Result<Option<Value>> {
    db.prepare(
        r#"
        UPDATE upload_sessions
        SET revoked=1
        WHERE id=?
        RETURNING id,created_at,expires_at,revoked,client
        "#,
    )
    .bind(&[id.into()])?
    .first::<Value>(None)
    .await
}

pub async fn list_rows(
    db: &D1Database,
    cursor: Option<(i64, String)>,
    limit: usize,
) -> Result<Vec<Value>> {
    let (time, id) = cursor.unwrap_or((i64::MAX, String::new()));
    db.prepare(
        r#"
        SELECT id,created_at,expires_at,revoked,client
        FROM upload_sessions
        WHERE created_at<?
          OR (created_at=? AND id<?)
        ORDER BY created_at DESC,id DESC
        LIMIT ?
        "#,
    )
    .bind(&[
        (time as f64).into(),
        (time as f64).into(),
        id.into(),
        ((limit + 1) as f64).into(),
    ])?
    .all()
    .await?
    .results::<Value>()
}

pub async fn is_active(db: &D1Database, token_hash: &str, now: i64) -> Result<bool> {
    Ok(db
        .prepare("SELECT id FROM upload_sessions WHERE token_hash=? AND revoked=0 AND expires_at>?")
        .bind(&[token_hash.into(), (now as f64).into()])?
        .first::<Value>(None)
        .await?
        .is_some())
}
