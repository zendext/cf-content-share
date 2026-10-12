mod models;
pub mod operations;
pub mod resources;
pub mod sessions;
pub mod uploads;
pub use models::*;

use crate::auth;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use worker::*;

#[derive(Deserialize)]
struct IdRow {
    id: String,
}

pub fn now() -> i64 {
    (Date::now().as_millis() / 1000) as i64
}
pub fn failure(code: &str, step: &str, retryable: bool) -> Value {
    let message = match code {
        "UNAUTHORIZED" => "上传会话缺失、已撤销或已到期。",
        "INVALID_METADATA" => "上传元数据不符合 session.create 返回的 Schema 或上传约束。",
        "INVALID_MULTIPART" => "请求必须使用合法的 multipart/form-data。",
        "FILE_TOO_LARGE" => "声明文件大小超过 MAX_FILE_BYTES。",
        "CAPACITY_EXCEEDED" => "已发布、预留及待清理空间之和无法容纳该文件。",
        "IMMUTABLE_FILE" => "托管文件的字节属性和目标不可编辑；请创建新资源。",
        "INVALID_ARGUMENTS" => "参数不符合 describe 返回的 Schema 或操作约束。",
        "UNKNOWN_OPERATION" => "操作未实现；请先调用 describe 查询当前目录。",
        "NOT_FOUND" => "未找到指定资源或操作。",
        "IDEMPOTENCY_CONFLICT" => "该操作标识已用于不同的创建参数。",
        "RESOURCE_EXPIRED" => "资源已到期，不能编辑或恢复。",
        "RESOURCE_DELETED" => "资源已永久删除，不能编辑或恢复。",
        "INVALID_CURSOR" => "游标无效或与当前列表及筛选条件不符。",
        "INVALID_TIME_RANGE" => "起始时刻必须早于结束时刻。",
        "STORAGE_UNAVAILABLE" => "D1 操作未能确认；请通过 operation.get 核对已保存状态后重试。",
        "ID_ALLOCATION_RETRY" => "资源 ID 分配冲突，请沿用原操作标识重试。",
        _ => "操作未完成。",
    };
    json!({"error":{"code":code,"step":step,"retryable":retryable,"message":message}})
}

pub fn resource_id() -> Result<String> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut id = String::with_capacity(12);
    while id.len() < 12 {
        let mut bytes = [0; 24];
        auth::crypto()?.get_random_values_with_u8_array(&mut bytes)?;
        for byte in bytes {
            // Rejection sampling avoids bias from 256 % 62.
            if byte < 248 && id.len() < 12 {
                id.push(ALPHABET[(byte % 62) as usize] as char);
            }
        }
    }
    Ok(id)
}

pub fn fingerprint(value: &Value) -> String {
    hex::encode(Sha256::digest(value.to_string().as_bytes()))
}

pub async fn operation_result(env: &Env, id: &str) -> Result<Value> {
    let Some(op) = operations::get(&env.d1("DB")?, id).await? else {
        return Ok(failure("NOT_FOUND", "lookup", false));
    };
    let resource = resources::get(&env.d1("DB")?, &op.resource_id)
        .await?
        .ok_or_else(|| Error::RustError("operation resource missing".into()))?;
    Ok(json!({"operation":op.output(),"resource":resource.output(env)?}))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    filter: String,
    created_at: i64,
    id: String,
}

pub fn page_key(args: &Value, scope: &str) -> String {
    let mut filters = args.clone();
    filters.as_object_mut().unwrap().remove("cursor");
    filters.as_object_mut().unwrap().remove("limit");
    fingerprint(&json!({"scope":scope,"filters":filters}))
}
pub fn decode_cursor(args: &Value, scope: &str) -> std::result::Result<Option<(i64, String)>, ()> {
    let Some(cursor) = args["cursor"].as_str() else {
        return Ok(None);
    };
    let decoded = URL_SAFE_NO_PAD.decode(cursor).map_err(|_| ())?;
    let cursor: Cursor = serde_json::from_slice(&decoded).map_err(|_| ())?;
    if cursor.filter != page_key(args, scope)
        || cursor.created_at < 0
        || cursor.id.is_empty()
        || cursor.id.len() > 128
    {
        return Err(());
    }
    Ok(Some((cursor.created_at, cursor.id)))
}
pub fn encode_cursor(args: &Value, scope: &str, created_at: i64, id: &str) -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&Cursor {
        filter: page_key(args, scope),
        created_at,
        id: id.into(),
    })?))
}

pub fn limit(env: &Env, name: &str) -> Result<Option<u64>> {
    env.var(name)
        .ok()
        .map(|v| {
            v.to_string()
                .parse::<u64>()
                .ok()
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or_else(|| Error::RustError("invalid storage limit".into()))
        })
        .transpose()
}
pub async fn storage(env: &Env) -> Result<Value> {
    let mut usage = env
        .d1("DB")?
        .prepare(
            "SELECT published_bytes,reserved_bytes,cleanup_bytes FROM storage_usage WHERE id=1",
        )
        .first::<Value>(None)
        .await?
        .ok_or_else(|| Error::RustError("missing storage accounting".into()))?;
    usage["total_storage_bytes"] = json!(limit(env, "TOTAL_STORAGE_BYTES")?);
    usage["max_file_bytes"] = json!(limit(env, "MAX_FILE_BYTES")?);
    Ok(usage)
}

pub fn object_key(id: &str, attempt_token: &str) -> String {
    format!(
        "objects/{id}/{}",
        hex::encode(Sha256::digest(attempt_token.as_bytes()))
    )
}

// Keep the pre-expiration canonical payload available only for version-zero operations.
pub fn creation_fingerprints(metadata: &mut Value) -> (String, Option<String>) {
    let legacy = if metadata.get("retention_seconds").is_none() {
        Some(fingerprint(metadata))
    } else {
        None
    };
    if metadata.get("retention_seconds").is_none() {
        metadata["retention_seconds"] = json!(2592000);
    }
    (fingerprint(metadata), legacy)
}
pub fn valid_retention(metadata: &Value) -> bool {
    metadata["retention_seconds"].is_null()
        || metadata["retention_seconds"]
            .as_i64()
            .is_some_and(|seconds| seconds > 0 && seconds <= 9_007_199_254_740_991 - now())
}
