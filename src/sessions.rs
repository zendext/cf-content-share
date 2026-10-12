use crate::{auth, store};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use worker::*;

pub async fn create(env: &Env, args: &Value) -> Result<Value> {
    let token = auth::random_token()?;
    let id = auth::random_token()?;
    let now = store::now();
    let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
    store::sessions::create(
        &env.d1("DB")?,
        &id,
        &token_hash,
        now,
        args["client"].as_str(),
    )
    .await?;
    Ok(
        json!({"session_id":id,"token":token,"created_at":now,"expires_at":now+86400,"upload":crate::catalog::upload_contract(&env.var("PUBLIC_ORIGIN")?.to_string())}),
    )
}
pub async fn revoke(env: &Env, id: &str) -> Result<Value> {
    let row = store::sessions::revoke(&env.d1("DB")?, id).await?;
    Ok(row.unwrap_or_else(|| store::failure("NOT_FOUND", "session", false)))
}
pub async fn list(env: &Env, args: &Value) -> Result<Value> {
    let cursor = match store::decode_cursor(args, "sessions") {
        Ok(cursor) => cursor,
        Err(_) => return Ok(store::failure("INVALID_CURSOR", "pagination", false)),
    };
    let limit = args["limit"].as_u64().unwrap_or(20) as usize;
    let mut rows = store::sessions::list_rows(&env.d1("DB")?, cursor, limit).await?;
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
    let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
    store::sessions::is_active(&env.d1("DB")?, &token_hash, store::now()).await
}
