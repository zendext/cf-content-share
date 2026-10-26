use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::Value;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use worker::{js_sys, *};

pub fn crypto() -> Result<web_sys::Crypto> {
    Ok(js_sys::Reflect::get(&js_sys::global(), &"crypto".into())?.unchecked_into())
}

pub fn random_token() -> Result<String> {
    let mut bytes = [0; 32];
    crypto()?.get_random_values_with_u8_array(&mut bytes)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
    aud: Vec<String>,
    exp: u64,
    nbf: Option<u64>,
    sub: String,
}

pub struct Access {
    pub token: String,
    pub expires_at: u64,
}

// Access owns OAuth; only its origin assertion is accepted here.
// JWKS is fetched from configured issuer, never from untrusted JWT headers.
pub async fn verify(req: &Request, env: &Env) -> Result<Access> {
    let invalid = || Error::RustError("invalid Access assertion".into());
    let token = req
        .headers()
        .get("Cf-Access-Jwt-Assertion")?
        .ok_or_else(invalid)?;
    if token.len() > 16384 {
        return Err(invalid());
    }
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(invalid());
    }
    let header: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    if header["alg"] != "RS256" {
        return Err(invalid());
    }
    let kid = header["kid"].as_str().ok_or_else(invalid)?;
    let claims: Claims =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    let issuer = env.var("ACCESS_ISSUER")?.to_string();
    let audience = env.var("ACCESS_AUD")?.to_string();
    let now = Date::now().as_millis() / 1000;
    if claims.iss != issuer
        || !claims.aud.contains(&audience)
        || claims.exp <= now
        || claims.nbf.is_some_and(|nbf| nbf > now)
        || claims.sub.is_empty()
    {
        return Err(invalid());
    }
    let url = Url::parse(&format!("{issuer}/cdn-cgi/access/certs"))?;
    if url.scheme() != "https"
        || !url
            .host_str()
            .is_some_and(|h| h.ends_with(".cloudflareaccess.com"))
    {
        return Err(invalid());
    }
    let mut response = Fetch::Url(url).send().await?;
    if response.status_code() != 200 {
        return Err(invalid());
    }
    let jwks: Value = response.json().await?;
    let key = jwks["keys"]
        .as_array()
        .and_then(|keys| {
            keys.iter()
                .find(|key| key["kid"] == kid && key["kty"] == "RSA")
        })
        .ok_or_else(invalid)?;
    let key = js_sys::JSON::parse(&key.to_string())?.unchecked_into::<js_sys::Object>();
    let algorithm = js_sys::JSON::parse(r#"{"name":"RSASSA-PKCS1-v1_5","hash":"SHA-256"}"#)?
        .unchecked_into::<js_sys::Object>();
    let usages = js_sys::Array::of1(&"verify".into());
    let subtle = crypto()?.subtle();
    let imported =
        JsFuture::from(subtle.import_key_with_object("jwk", &key, &algorithm, false, &usages)?)
            .await?
            .unchecked_into::<web_sys::CryptoKey>();
    let signature = URL_SAFE_NO_PAD.decode(parts[2]).map_err(|_| invalid())?;
    let verified = JsFuture::from(subtle.verify_with_str_and_u8_array_and_u8_array(
        "RSASSA-PKCS1-v1_5",
        &imported,
        &signature,
        format!("{}.{}", parts[0], parts[1]).as_bytes(),
    )?)
    .await?;
    if verified.as_bool() != Some(true) {
        return Err(invalid());
    }
    Ok(Access {
        token,
        expires_at: claims.exp,
    })
}
