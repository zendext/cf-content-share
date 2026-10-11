use crate::{auth, error, json_response};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use worker::*;

const VERSION: &str = "2025-06-18";

#[derive(Clone, Copy)]
enum Operation {
    Echo,
    CreateSession,
    RevokeSession,
    GetUpload,
}

// One catalog feeds discovery, schema lookup and dispatch validation.
fn operations() -> Vec<(Operation, &'static str, &'static str, Value)> {
    vec![
        (
            Operation::Echo,
            "prototype.echo",
            "验证 Rust/Wasm 工具调用",
            json!({"type":"object","properties":{"message":{"type":"string"}},"required":["message"],"additionalProperties":false}),
        ),
        (
            Operation::CreateSession,
            "session.create",
            "创建 24 小时上传 Token",
            json!({"type":"object","properties":{},"additionalProperties":false}),
        ),
        (
            Operation::RevokeSession,
            "session.revoke",
            "撤销上传 Token",
            json!({"type":"object","properties":{"session_id":{"type":"string"}},"required":["session_id"],"additionalProperties":false}),
        ),
        (
            Operation::GetUpload,
            "operation.get",
            "查询原型上传状态，不执行后台恢复",
            json!({"type":"object","properties":{"operation_id":{"type":"string"}},"required":["operation_id"],"additionalProperties":false}),
        ),
    ]
}

fn tool_result(value: Value, failed: bool) -> Value {
    json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":failed})
}
fn tool_error(code: &str) -> Value {
    tool_result(json!({"error":{"code":code}}), true)
}
fn rpc_error(id: &Value, code: i32, message: &str) -> Result<Response> {
    json_response(
        &json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}),
        200,
    )
}

pub async fn handle(req: &mut Request, env: &Env) -> Result<Response> {
    if let Some(origin) = req.headers().get("Origin")?
        && origin != env.var("PUBLIC_ORIGIN")?.to_string()
    {
        return error("INVALID_ORIGIN", 403);
    }
    if auth::verify(req, env).await.is_err() {
        return error("UNAUTHORIZED", 401);
    }
    if req.method() != Method::Post {
        let mut response = error("METHOD_NOT_ALLOWED", 405)?;
        response.headers_mut().set("Allow", "POST")?;
        return Ok(response);
    }
    if let Some(version) = req.headers().get("MCP-Protocol-Version")?
        && version != VERSION
    {
        return error("UNSUPPORTED_PROTOCOL_VERSION", 400);
    }
    let accept = req.headers().get("Accept")?.unwrap_or_default();
    if !accept.contains("application/json") || !accept.contains("text/event-stream") {
        return error("NOT_ACCEPTABLE", 406);
    }
    if !req
        .headers()
        .get("Content-Type")?
        .unwrap_or_default()
        .starts_with("application/json")
    {
        return error("UNSUPPORTED_MEDIA_TYPE", 415);
    }
    let mut stream = req.stream()?;
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if body.len() + chunk.len() > 65536 {
            return error("MCP_BODY_TOO_LARGE", 413);
        }
        body.extend(chunk);
    }
    let value: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return rpc_error(&Value::Null, -32700, "Parse error"),
    };
    let id = &value["id"];
    if value["jsonrpc"] != "2.0"
        || !value["method"].is_string()
        || (!id.is_null() && !id.is_string() && !id.is_i64())
    {
        return rpc_error(&Value::Null, -32600, "Invalid Request");
    }
    if value.get("id").is_none() {
        return Ok(Response::empty()?.with_status(202));
    }
    let result = match value["method"].as_str().unwrap_or_default() {
        "initialize" => {
            json!({"protocolVersion":VERSION,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"cf-content-share-compat","version":"0.1.0"},"instructions":"兼容性原型：先调用 describe，按目录调用 invoke。"})
        }
        "ping" => json!({}),
        "tools/list" => json!({"tools":[
            {"name":"describe","description":"先查询 operation 目录，不熟悉参数时指定 operation 获取 Schema。","inputSchema":{"type":"object","properties":{"operation":{"type":"string"}},"additionalProperties":false},"annotations":{"readOnlyHint":true}},
            {"name":"invoke","description":"执行 describe 列出的 operation；请先查参数，不要猜测名称。","inputSchema":{"type":"object","properties":{"operation":{"type":"string"},"arguments":{"type":"object"}},"required":["operation","arguments"],"additionalProperties":false},"annotations":{"readOnlyHint":false}}
        ]}),
        "tools/call" => match value["params"]["name"].as_str() {
            Some("describe") => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Describe {
                    operation: Option<String>,
                }
                let args = value["params"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or(json!({}));
                match serde_json::from_value::<Describe>(args) {
                    Err(_) => tool_error("INVALID_ARGUMENTS"),
                    Ok(Describe { operation: None }) => tool_result(
                        json!({"operations":operations().iter().map(|(_,name,description,_)| json!({"name":name,"description":description})).collect::<Vec<_>>()}),
                        false,
                    ),
                    Ok(Describe {
                        operation: Some(name),
                    }) => match operations().into_iter().find(|op| op.1 == name) {
                        Some((_, name, description, schema)) => tool_result(
                            json!({"name":name,"description":description,"inputSchema":schema}),
                            false,
                        ),
                        None => tool_error("UNKNOWN_OPERATION"),
                    },
                }
            }
            Some("invoke") => invoke(&value["params"]["arguments"], env).await?,
            _ => return rpc_error(id, -32602, "Unknown tool"),
        },
        _ => return rpc_error(id, -32601, "Method not found"),
    };
    json_response(&json!({"jsonrpc":"2.0","id":id,"result":result}), 200)
}

async fn invoke(input: &Value, env: &Env) -> Result<Value> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Invoke {
        operation: String,
        arguments: Value,
    }
    let Ok(args) = serde_json::from_value::<Invoke>(input.clone()) else {
        return Ok(tool_error("INVALID_ARGUMENTS"));
    };
    let Some((operation, _, _, schema)) =
        operations().into_iter().find(|op| op.1 == args.operation)
    else {
        return Ok(tool_error("UNKNOWN_OPERATION"));
    };
    // All prototype arguments are flat strings, validated against that same catalog.
    let Some(values) = args.arguments.as_object() else {
        return Ok(tool_error("INVALID_ARGUMENTS"));
    };
    let properties = schema["properties"].as_object().unwrap();
    if values.len() != properties.len()
        || values
            .iter()
            .any(|(k, v)| !properties.contains_key(k) || !v.is_string())
    {
        return Ok(tool_error("INVALID_ARGUMENTS"));
    }
    let db = env.d1("DB")?;
    let result = match operation {
        Operation::Echo => args.arguments,
        Operation::CreateSession => {
            let token = auth::random_token()?;
            let id = auth::random_token()?;
            let now = (Date::now().as_millis() / 1000) as i64;
            db.prepare("INSERT INTO upload_sessions(id,token_hash,expires_at) VALUES(?,?,?)")
                .bind(&[
                    id.clone().into(),
                    hex::encode(Sha256::digest(token.as_bytes())).into(),
                    ((now + 86400) as f64).into(),
                ])?
                .run()
                .await?;
            json!({"session_id":id,"token":token,"created_at":now,"expires_at":now+86400,"upload":{"url":format!("{}/upload",env.var("PUBLIC_ORIGIN")?),"method":"POST","authorization":"Bearer <token>","body":"multipart/form-data: metadata JSON first, then file","metadata":{"required":["operation_id","filename","content_type","size_bytes","sha256"]}}})
        }
        Operation::RevokeSession => {
            db.prepare("UPDATE upload_sessions SET revoked=1 WHERE id=?")
                .bind(&[args.arguments["session_id"].as_str().unwrap().into()])?
                .run()
                .await?;
            json!({"revoked":true})
        }
        Operation::GetUpload => {
            let row = db.prepare("SELECT operation_id,resource_id,state,size_bytes FROM uploads WHERE operation_id=?").bind(&[args.arguments["operation_id"].as_str().unwrap().into()])?.first::<Value>(None).await?;
            match row {
                Some(row) => row,
                None => return Ok(tool_error("NOT_FOUND")),
            }
        }
    };
    Ok(tool_result(result, false))
}
