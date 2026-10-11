use crate::{error, store};
use serde::{Deserialize, Serialize};
use worker::*;

pub const FRESHNESS_SECONDS: i64 = 60;
#[derive(Deserialize, Serialize)]
pub struct Mapping {
    id: String,
    kind: String,
    state: String,
    target_url: Option<String>,
    observed_at: i64,
    valid_until: i64,
}

pub async fn snapshot(env: &Env, id: &str) -> Result<Option<Mapping>> {
    // Capture before reading D1: a delayed read/write must not renew an old snapshot.
    let observed_at = store::now();
    Ok(store::resource(env, id).await?.map(|resource| Mapping {
        id: resource.id,
        kind: resource.kind,
        state: resource.state,
        target_url: resource.target_url,
        observed_at,
        valid_until: observed_at + FRESHNESS_SECONDS,
    }))
}
pub async fn write(env: &Env, mapping: &Mapping) -> Result<()> {
    env.kv("MAPPINGS")?
        .put(&mapping.id, serde_json::to_string(mapping)?)?
        .expiration_ttl(120)
        .execute()
        .await?;
    Ok(())
}
impl Mapping {
    fn valid(&self, id: &str) -> bool {
        let now = store::now();
        self.id == id
            && self.kind == "url"
            && matches!(self.state.as_str(), "published" | "deleted")
            && self.observed_at <= now
            && self.valid_until > now
            && self.valid_until - self.observed_at == FRESHNESS_SECONDS
            && (self.state == "deleted"
                || self.target_url.as_ref().is_some_and(|url| {
                    Url::parse(url).is_ok_and(|url| {
                        matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
                    })
                }))
    }
}

pub async fn read(id: &str, env: &Env) -> Result<Response> {
    if id.len() != 12 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return error("NOT_FOUND", 404);
    }
    let cached = match env.kv("MAPPINGS") {
        Ok(kv) => kv
            .get(id)
            .json::<Mapping>()
            .await
            .ok()
            .flatten()
            .filter(|mapping| mapping.valid(id)),
        Err(_) => None,
    };
    let mapping = match cached {
        Some(mapping) => mapping,
        None => match snapshot(env, id).await {
            Ok(Some(mapping)) => {
                let _ = write(env, &mapping).await;
                mapping
            }
            Ok(None) => return error("NOT_FOUND", 404),
            Err(_) => return error("SERVICE_UNAVAILABLE", 503),
        },
    };
    if mapping.state != "published" {
        return error("NOT_FOUND", 404);
    }
    let Some(url) = mapping.target_url else {
        return error("SERVICE_UNAVAILABLE", 503);
    };
    let mut response = Response::empty()?.with_status(302);
    response.headers_mut().set("Location", &url)?;
    response.headers_mut().set("Cache-Control", "no-store")?;
    Ok(response)
}
