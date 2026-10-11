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
    #[serde(default)]
    file_key: Option<String>,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    size_bytes: Option<u64>,
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
        file_key: resource.file_key,
        filename: resource.filename,
        content_type: resource.content_type,
        size_bytes: resource.size_bytes,
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
            && matches!(self.kind.as_str(), "url" | "image" | "file")
            && matches!(self.state.as_str(), "published" | "deleted")
            && self.observed_at <= now
            && self.valid_until > now
            && self.valid_until - self.observed_at == FRESHNESS_SECONDS
            && (self.state != "published"
                || (self.kind != "url"
                    && self
                        .file_key
                        .as_ref()
                        .is_some_and(|key| key.starts_with(&format!("objects/{}/", self.id)))
                    && self.filename.is_some()
                    && self.content_type.is_some()
                    && self.size_bytes.is_some())
                || (self.kind == "url"
                    && self.target_url.as_ref().is_some_and(|url| {
                        Url::parse(url).is_ok_and(|url| {
                            matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
                        })
                    })))
    }
}

pub struct PublicRead {
    pub response: Response,
    pub kind: Option<String>,
}
fn rejected(code: &str, status: u16) -> Result<PublicRead> {
    Ok(PublicRead {
        response: error(code, status)?,
        kind: None,
    })
}
pub async fn read(req: &Request, id: &str, env: &Env, ctx: &Context) -> Result<PublicRead> {
    if id.len() != 12 || !id.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return rejected("NOT_FOUND", 404);
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
            Ok(None) => return rejected("NOT_FOUND", 404),
            Err(_) => return rejected("SERVICE_UNAVAILABLE", 503),
        },
    };
    if mapping.state != "published" {
        return rejected("NOT_FOUND", 404);
    }
    let response = if mapping.kind == "url" {
        let Some(url) = mapping.target_url else {
            return rejected("SERVICE_UNAVAILABLE", 503);
        };
        let mut response = Response::empty()?.with_status(302);
        response.headers_mut().set("Location", &url)?;
        response.headers_mut().set("Cache-Control", "no-store")?;
        response
    } else {
        match file(req, &mapping, env, ctx).await {
            Ok(response) => response,
            Err(_) => return rejected("SERVICE_UNAVAILABLE", 503),
        }
    };
    let kind = if matches!(response.status_code(), 200 | 206 | 302) {
        Some(mapping.kind)
    } else {
        None
    };
    Ok(PublicRead { response, kind })
}

async fn file(req: &Request, mapping: &Mapping, env: &Env, ctx: &Context) -> Result<Response> {
    let size = mapping.size_bytes.unwrap();
    let range = if req.method() == Method::Get {
        req.headers().get("Range")?
    } else {
        None
    };
    let range = match range.as_deref().map(|r| parse_range(r, size)).transpose() {
        Ok(range) => range,
        Err(()) => {
            let mut response = error("INVALID_RANGE", 416)?;
            response
                .headers_mut()
                .set("Content-Range", &format!("bytes */{size}"))?;
            return Ok(response);
        }
    };
    let cache_key = format!("{}/r/{}", env.var("PUBLIC_ORIGIN")?, mapping.id);
    if req.method() == Method::Get
        && range.is_none()
        && let Ok(Some(mut response)) = Cache::default().get(cache_key.clone(), true).await
        && response.status_code() == 200
    {
        // Cache API responses carry immutable headers; copy only the headers,
        // retaining the stream without buffering its body.
        let headers = response.headers().clone();
        response = response.with_headers(headers);
        response
            .headers_mut()
            .set("Cache-Control", "private, max-age=31536000, immutable")?;
        return Ok(response);
    }
    let bucket = env.bucket("FILES")?;
    let key = mapping.file_key.as_ref().unwrap();
    let mut response = if req.method() == Method::Head {
        if bucket.head(key).await?.is_none() {
            return error("NOT_FOUND", 404);
        }
        Response::empty()?
    } else {
        let mut get = bucket.get(key);
        if let Some((start, end)) = range {
            get = get.range(Range::OffsetWithLength {
                offset: start,
                length: end - start + 1,
            });
        }
        let Some(object) = get.execute().await? else {
            return error("NOT_FOUND", 404);
        };
        let body = object
            .body()
            .ok_or_else(|| Error::RustError("missing object body".into()))?;
        Response::from_stream(body.stream()?)?.with_status(if range.is_some() { 206 } else { 200 })
    };
    response
        .headers_mut()
        .set("Content-Type", mapping.content_type.as_ref().unwrap())?;
    response.headers_mut().set("Accept-Ranges", "bytes")?;
    response
        .headers_mut()
        .set("X-Content-Type-Options", "nosniff")?;
    let filename = mapping.filename.as_ref().unwrap();
    let fallback: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || " ._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded: String = filename
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    response.headers_mut().set(
        "Content-Disposition",
        &format!(
            "{}; filename=\"{}\"; filename*=UTF-8''{}",
            if mapping.kind == "image" {
                "inline"
            } else {
                "attachment"
            },
            fallback,
            encoded
        ),
    )?;
    let length = if let Some((start, end)) = range {
        response
            .headers_mut()
            .set("Content-Range", &format!("bytes {start}-{end}/{size}"))?;
        end - start + 1
    } else {
        size
    };
    response
        .headers_mut()
        .set("Content-Length", &length.to_string())?;
    if req.method() == Method::Get && range.is_none() {
        response
            .headers_mut()
            .set("Cache-Control", "public, max-age=86400")?;
        if let Ok(copy) = response.cloned() {
            ctx.wait_until(async move {
                let _ = Cache::default().put(cache_key, copy).await;
            });
        }
    }
    response
        .headers_mut()
        .set("Cache-Control", "private, max-age=31536000, immutable")?;
    Ok(response)
}

fn parse_range(value: &str, size: u64) -> std::result::Result<(u64, u64), ()> {
    let value = value.strip_prefix("bytes=").ok_or(())?;
    let (left, right) = value.split_once('-').ok_or(())?;
    if size == 0
        || (!left.is_empty() && !left.bytes().all(|b| b.is_ascii_digit()))
        || (!right.is_empty() && !right.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(());
    }
    if left.is_empty() {
        let suffix = right.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        return Ok((size.saturating_sub(suffix), size - 1));
    }
    let start = left.parse::<u64>().map_err(|_| ())?;
    let end = if right.is_empty() {
        size - 1
    } else {
        right.parse::<u64>().map_err(|_| ())?.min(size - 1)
    };
    if start >= size || start > end {
        return Err(());
    }
    Ok((start, end))
}
