use crate::{auth, store};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use worker::*;

pub async fn create(env: &Env, args: &Value) -> Result<Value> {
    let token = auth::random_token()?;
    let id = auth::random_token()?;
    let now = store::now();
    env.d1("DB")?.prepare("INSERT INTO upload_sessions(id,token_hash,created_at,expires_at,client) VALUES(?,?,?,?,?)")
        .bind(&[id.clone().into(), hex::encode(Sha256::digest(token.as_bytes())).into(), (now as f64).into(), ((now+86400) as f64).into(), args["client"].as_str().map(Into::into).unwrap_or(wasm_bindgen::JsValue::NULL)])?.run().await?;
    Ok(
        json!({"session_id":id,"token":token,"created_at":now,"expires_at":now+86400,"upload":crate::catalog::upload_contract(&env.var("PUBLIC_ORIGIN")?.to_string())}),
    )
}
pub async fn revoke(env: &Env, id: &str) -> Result<Value> {
    let row = env.d1("DB")?.prepare("UPDATE upload_sessions SET revoked=1 WHERE id=? RETURNING id,created_at,expires_at,revoked,client").bind(&[id.into()])?.first::<Value>(None).await?;
    Ok(row.unwrap_or_else(|| store::failure("NOT_FOUND", "session", false)))
}
pub async fn list(env: &Env, args: &Value) -> Result<Value> {
    let cursor = match store::decode_cursor(args, "sessions") {
        Ok(cursor) => cursor,
        Err(_) => return Ok(store::failure("INVALID_CURSOR", "pagination", false)),
    };
    let limit = args["limit"].as_u64().unwrap_or(20) as usize;
    let (time, id) = cursor.unwrap_or((i64::MAX, String::new()));
    let mut rows=env.d1("DB")?.prepare("SELECT id,created_at,expires_at,revoked,client FROM upload_sessions WHERE created_at<? OR (created_at=? AND id<?) ORDER BY created_at DESC,id DESC LIMIT ?")
        .bind(&[(time as f64).into(),(time as f64).into(),id.into(),((limit+1) as f64).into()])?.all().await?.results::<Value>()?;
    let more = rows.len() > limit;
    rows.truncate(limit);
    let next = if more {
        let row = rows.last().unwrap();
        Some(store::encode_cursor(
            args,
            "sessions",
            row["created_at"].as_i64().unwrap(),
            row["id"].as_str().unwrap(),
        )?)
    } else {
        None
    };
    Ok(json!({"items":rows,"has_more":more,"next_cursor":next}))
}
pub async fn authorized(req: &Request, env: &Env) -> Result<bool> {
    let header = req.headers().get("Authorization")?.unwrap_or_default();
    let Some(token) = header.strip_prefix("Bearer ").filter(|s| s.len() == 43) else {
        return Ok(false);
    };
    Ok(env
        .d1("DB")?
        .prepare("SELECT id FROM upload_sessions WHERE token_hash=? AND revoked=0 AND expires_at>?")
        .bind(&[
            hex::encode(Sha256::digest(token.as_bytes())).into(),
            (store::now() as f64).into(),
        ])?
        .first::<Value>(None)
        .await?
        .is_some())
}
