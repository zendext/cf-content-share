mod auth;
mod mcp;
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
async fn fetch(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let result = match (req.method(), req.path().as_str()) {
        (_, "/mcp") => mcp::handle(&mut req, &env).await,
        (Method::Post, "/upload") => upload::handle(&mut req, &env).await,
        (Method::Get, "/r/probe") => {
            json_response(&json!({"prototype":true,"anonymous":true}), 200)
        }
        (Method::Get, path) if path.starts_with("/r/") => upload::read(&path[3..], &env).await,
        _ => error("NOT_FOUND", 404),
    };
    // Keep runtime diagnostics out of responses: platform errors may contain request data.
    match result {
        Ok(response) => Ok(response),
        Err(_) => error("PROTOTYPE_INTERNAL_ERROR", 500),
    }
}
