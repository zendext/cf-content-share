use crate::auth;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use worker::*;

pub fn now() -> i64 {
    (Date::now().as_millis() / 1000) as i64
}
pub fn failure(code: &str, step: &str, retryable: bool) -> Value {
    let message = match code {
        "INVALID_ARGUMENTS" => "参数不符合 describe 返回的 Schema 或操作约束。",
        "UNKNOWN_OPERATION" => "操作未实现；请先调用 describe 查询当前目录。",
        "NOT_FOUND" => "未找到指定资源或操作。",
        "IDEMPOTENCY_CONFLICT" => "该操作标识已用于不同的创建参数。",
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

#[derive(Deserialize, Serialize)]
pub struct Resource {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub target_url: Option<String>,
    pub title: String,
    pub description: String,
    pub tags: String,
    pub created_at: i64,
    pub deleted_at: Option<i64>,
}
impl Resource {
    pub fn output(&self, env: &Env) -> Result<Value> {
        let mut value = serde_json::to_value(self)?;
        value["tags"] = serde_json::from_str(&self.tags)?;
        value["share_url"] = json!(format!("{}/r/{}", env.var("PUBLIC_ORIGIN")?, self.id));
        Ok(value)
    }
}
pub async fn resource(env: &Env, id: &str) -> Result<Option<Resource>> {
    // Non-session D1 bindings always use the primary, including with read replication enabled.
    env.d1("DB")?
        .prepare("SELECT * FROM resources WHERE id=?")
        .bind(&[id.into()])?
        .first(None)
        .await
}

#[derive(Deserialize, Serialize)]
pub struct Operation {
    pub id: String,
    pub r#type: String,
    pub resource_id: String,
    pub fingerprint: String,
    pub status: String,
    pub kv_status: String,
    pub error_code: Option<String>,
    pub retry_count: i64,
    pub total_attempts: i64,
    pub next_retry_at: Option<i64>,
    pub lease_token: Option<String>,
    pub lease_until: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}
impl Operation {
    pub fn output(&self) -> Value {
        json!({"operation_id":self.id,"type":self.r#type,"resource_id":self.resource_id,"status":self.status,"steps":{"d1":"completed","kv":self.kv_status},"last_error":self.error_code.as_ref().map(|code| json!({"code":code,"step":"kv_sync","retryable":true,"message":"同步未完成；任务已保存，按 operation 状态判断是否等待或手动重试。"})),"retry_count":self.retry_count,"total_attempts":self.total_attempts,"next_retry_at":self.next_retry_at,"created_at":self.created_at,"updated_at":self.updated_at})
    }
}
pub async fn operation(env: &Env, id: &str) -> Result<Option<Operation>> {
    env.d1("DB")?
        .prepare("SELECT * FROM operations WHERE id=?")
        .bind(&[id.into()])?
        .first(None)
        .await
}
pub async fn operation_result(env: &Env, id: &str) -> Result<Value> {
    let Some(op) = operation(env, id).await? else {
        return Ok(failure("NOT_FOUND", "lookup", false));
    };
    let resource = resource(env, &op.resource_id)
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
