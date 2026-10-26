use crate::{auth, catalog, error, json_response, recovery, resources, sessions, stats, store};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use worker::*;

// Newest first: initialization falls back to the preferred supported version.
const SUPPORTED_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18"];

fn tool_result(value: Value, failed: bool) -> Value {
    json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":failed})
}
fn tool_error(code: &str) -> Value {
    tool_result(store::failure(code, "validation", false), true)
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
    let Ok(access) = auth::verify(req, env).await else {
        return error("UNAUTHORIZED", 401);
    };
    if req.method() != Method::Post {
        let mut response = error("METHOD_NOT_ALLOWED", 405)?;
        response.headers_mut().set("Allow", "POST")?;
        return Ok(response);
    }
    if let Some(version) = req.headers().get("MCP-Protocol-Version")?
        && !SUPPORTED_VERSIONS.contains(&version.as_str())
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
        let mut response = Response::empty()?.with_status(202);
        response.headers_mut().set("Cache-Control", "no-store")?;
        return Ok(response);
    }
    let result = match value["method"].as_str().unwrap_or_default() {
        "initialize" => {
            let version = value["params"]["protocolVersion"]
                .as_str()
                .filter(|version| SUPPORTED_VERSIONS.contains(version))
                .unwrap_or(SUPPORTED_VERSIONS[0]);
            json!({"protocolVersion":version,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"cf-content-share","version":"0.1.0"},"instructions":"先调用 describe，按目录调用 invoke；通过 session.create 发现 HTTP 上传协议；文件正文不放入 MCP JSON。"})
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
                let explicitly_null = args.get("operation").is_some_and(Value::is_null);
                match serde_json::from_value::<Describe>(args) {
                    Ok(_) if explicitly_null => tool_error("INVALID_ARGUMENTS"),
                    Err(_) => tool_error("INVALID_ARGUMENTS"),
                    Ok(Describe { operation: None }) => tool_result(
                        json!({"operations":catalog::definitions().iter().map(|op| json!({"name":op.name,"description":op.description})).collect::<Vec<_>>(),"defaults":{"resource_id_length":12,"list_limit":20,"list_max_limit":100,"mapping_freshness_seconds":crate::public::FRESHNESS_SECONDS,"time_format":"UTC Unix seconds","automatic_retry_limit":10,"upload_session_seconds":86400},"implementation":"url-and-file-resources, analytics, durable-recovery"}),
                        false,
                    ),
                    Ok(Describe {
                        operation: Some(name),
                    }) => match catalog::definitions()
                        .into_iter()
                        .find(|op| op.name == name)
                    {
                        Some(op) => {
                            let mut detail = json!({"name":op.name,"description":op.description,"inputSchema":op.schema,"result":op.result,"side_effects":op.side_effects,"example":op.example});
                            match op.operation {
                                catalog::Action::CreateSession => {
                                    detail["upload"] = catalog::upload_contract(
                                        &env.var("PUBLIC_ORIGIN")?.to_string(),
                                    )
                                }
                                catalog::Action::UploadAuthorization => {
                                    detail["upload"] = catalog::oauth_upload_contract(
                                        &env.var("PUBLIC_ORIGIN")?.to_string(),
                                    )
                                }
                                catalog::Action::GetOperation => {
                                    detail["resultSchema"] = catalog::operation_result_schema();
                                    detail["result_semantics"] =
                                        catalog::resource_result_semantics();
                                }
                                catalog::Action::CreateUrl
                                | catalog::Action::GetResource
                                | catalog::Action::UpdateResource
                                | catalog::Action::DeleteResource => {
                                    detail["result_semantics"] =
                                        catalog::resource_result_semantics();
                                }
                                _ => {}
                            }
                            tool_result(detail, false)
                        }
                        None => tool_error("UNKNOWN_OPERATION"),
                    },
                }
            }
            Some("invoke") => invoke(&value["params"]["arguments"], env, &access).await?,
            _ => return rpc_error(id, -32602, "Unknown tool"),
        },
        _ => return rpc_error(id, -32601, "Method not found"),
    };
    json_response(&json!({"jsonrpc":"2.0","id":id,"result":result}), 200)
}

async fn invoke(input: &Value, env: &Env, access: &auth::Access) -> Result<Value> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Invoke {
        operation: String,
        arguments: Value,
    }
    let Ok(args) = serde_json::from_value::<Invoke>(input.clone()) else {
        return Ok(tool_error("INVALID_ARGUMENTS"));
    };
    let Some(definition) = catalog::definitions()
        .into_iter()
        .find(|op| op.name == args.operation)
    else {
        return Ok(tool_error("UNKNOWN_OPERATION"));
    };
    if !catalog::validate(&definition.schema, &args.arguments) {
        return Ok(tool_error("INVALID_ARGUMENTS"));
    }
    use catalog::Action;
    let a = &args.arguments;
    let result = match definition.operation {
        Action::StatsQuery => stats::query(env, a, false).await,
        Action::StatsSamples => stats::query(env, a, true).await,
        Action::CreateSession => sessions::create(env, a).await,
        Action::ListSessions => sessions::list(env, a).await,
        Action::RevokeSession => sessions::revoke(env, a["session_id"].as_str().unwrap()).await,
        Action::UploadAuthorization => Ok(json!({
            "token":access.token,
            "expires_at":access.expires_at,
            "upload":catalog::oauth_upload_contract(&env.var("PUBLIC_ORIGIN")?.to_string())
        })),
        Action::Storage => store::storage(env).await,
        Action::CreateUrl => resources::create(env, a).await,
        Action::ListResources => resources::list(env, a, false).await,
        Action::GetResource => resources::get(env, a["resource_id"].as_str().unwrap()).await,
        Action::UpdateResource => resources::update(env, a, false).await,
        Action::DeleteResource => resources::update(env, a, true).await,
        Action::ListOperations => resources::list(env, a, true).await,
        Action::GetOperation => {
            store::operation_result(env, a["operation_id"].as_str().unwrap()).await
        }
        Action::RetryOperation => recovery::retry(env, a["operation_id"].as_str().unwrap()).await,
    };
    let result = result.unwrap_or_else(|_| store::failure("STORAGE_UNAVAILABLE", "d1", true));
    let failed = result.get("error").is_some();
    Ok(tool_result(result, failed))
}
