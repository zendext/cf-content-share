mod auth;
mod catalog;
mod mcp;
mod public;
mod recovery;
mod resources;
mod sessions;
mod stats;
mod store;
mod upload;

use serde_json::json;
use worker::*;

pub fn json_response(value: &serde_json::Value, status: u16) -> Result<Response> {
    let mut response = Response::from_json(value)?.with_status(status);
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}

pub fn error(code: &str, status: u16) -> Result<Response> {
    json_response(&json!({"error":{"code":code}}), status)
}

#[event(fetch)]
async fn fetch(mut req: Request, env: Env, ctx: Context) -> Result<Response> {
    let result = match (req.method(), req.path().as_str()) {
        (Method::Post, "/upload" | "/mcp/upload") => upload::handle(&mut req, &env).await,
        (_, "/mcp") => mcp::handle(&mut req, &env).await,
        (Method::Get | Method::Head, path) if path.starts_with("/r/") => {
            match public::read(&req, &path[3..], &env, &ctx).await {
                Ok(read) => {
                    if let Some(kind) = read.kind {
                        stats::collect(&req, &env, &path[3..], &kind, read.response.status_code());
                    }
                    Ok(read.response)
                }
                Err(error) => Err(error),
            }
        }
        _ => error("NOT_FOUND", 404),
    };
    // Keep runtime diagnostics out of responses: platform errors may contain request data.
    match result {
        Ok(response) => Ok(response),
        Err(_) => error("INTERNAL_ERROR", 500),
    }
}

#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    if recovery::run(&env).await.is_err() {
        console_error!("RECOVERY_STORAGE_UNAVAILABLE");
    }
}
