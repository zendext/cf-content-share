use crate::store;
use futures_util::StreamExt;
use serde_json::{Value, json};
use wasm_bindgen::{JsCast, JsValue};
use worker::*;

// Shared event schema: blob1 event ID, blob2 resource ID, blob3 kind,
// blob4 raw Referer, blob5 country, blob6 region, blob7 city;
// double1 UTC Unix seconds, double2 HTTP status; index1 resource ID.
const EVENT: &str = "blob1";
const RESOURCE: &str = "blob2";
const KIND: &str = "blob3";
const REFERER: &str = "blob4";
const COUNTRY: &str = "blob5";
const REGION: &str = "blob6";
const CITY: &str = "blob7";
const TIME: &str = "double1";
const STATUS: &str = "double2";
const WINDOW: i64 = 30 * 86400;

/// Submission is synchronous; the Workers runtime delivers in the background.
/// Detectable failures never change the already-formed public response.
pub fn collect(req: &Request, env: &Env, resource_id: &str, kind: &str, status: u16) {
    if req.method() != Method::Get || !matches!(status, 200 | 206 | 302) {
        return;
    }
    let result = (|| -> Result<()> {
        let id = store::resource_id()?;
        let cf = req.cf();
        let blobs = [
            id,
            resource_id.into(),
            kind.into(),
            req.headers().get("Referer")?.unwrap_or_default(),
            cf.and_then(|cf| cf.country()).unwrap_or_default(),
            cf.and_then(|cf| cf.region()).unwrap_or_default(),
            cf.and_then(|cf| cf.city()).unwrap_or_default(),
        ];
        if resource_id.len() > 96 || blobs.iter().map(String::len).sum::<usize>() > 16 * 1024 {
            console_error!("ANALYTICS_EVENT_TOO_LARGE");
            return Ok(());
        }
        AnalyticsEngineDataPointBuilder::new()
            .indexes([resource_id])
            .blobs(blobs)
            .doubles([store::now() as f64, status as f64])
            .write_to(&env.analytics_engine("ANALYTICS")?)
    })();
    if result.is_err() {
        console_error!("ANALYTICS_COLLECTION_FAILED");
    }
}

// Use the platform's IANA database without adding a second timezone database.
fn valid_timezone(zone: &str) -> bool {
    if zone.is_empty()
        || zone.len() > 128
        || !zone
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_+-".contains(&b))
        || zone.starts_with(['+', '-'])
    {
        return false;
    }
    let validate = || -> std::result::Result<(), JsValue> {
        let intl = js_sys::Reflect::get(&js_sys::global(), &"Intl".into())?;
        let constructor = js_sys::Reflect::get(&intl, &"DateTimeFormat".into())?
            .dyn_into::<js_sys::Function>()?;
        let options = js_sys::Object::new();
        js_sys::Reflect::set(&options, &"timeZone".into(), &zone.into())?;
        let args = js_sys::Array::new();
        args.push(&"en-US".into());
        args.push(&options);
        js_sys::Reflect::construct(&constructor, &args)?;
        Ok(())
    };
    validate().is_ok()
}

fn failure(code: &str, retryable: bool) -> Value {
    let mut value = store::failure(code, "analytics", retryable);
    value["error"]["message"] = json!(match code {
        "INVALID_TIME_RANGE" =>
            "必须提供最近 30 天内的 UTC Unix 秒区间 [start,end)，且 start < end；不允许未来时间。",
        "INVALID_TIMEZONE" => "时区必须是平台支持的 IANA 时区名称。",
        "ANALYTICS_NOT_CONFIGURED" => "统计绑定、数据集、账户或查询密钥未正确配置。",
        "ANALYTICS_QUERY_FAILED" => "统计平台查询失败；未返回访问量，请稍后重试。",
        "ANALYTICS_RESPONSE_INVALID" => "统计平台返回无效或超出限制的结果。",
        _ => "统计查询未完成。",
    });
    value
}

async fn sql_request(account: &str, token: &str, sql: String) -> Result<Value> {
    let headers = Headers::new();
    headers.set("Authorization", &format!("Bearer {token}"))?;
    headers.set("Content-Type", "text/plain")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(sql.into()));
    init.with_redirect(RequestRedirect::Manual);
    let request = Request::new_with_init(
        &format!("https://api.cloudflare.com/client/v4/accounts/{account}/analytics_engine/sql"),
        &init,
    )?;
    let mut response = Fetch::Request(request).send().await?;
    if response.status_code() != 200 {
        console_error!(
            "ANALYTICS_QUERY_HTTP_FAILED status={}",
            response.status_code()
        );
        return Ok(failure("ANALYTICS_QUERY_FAILED", true));
    }
    let mut bytes = Vec::new();
    let mut stream = response.stream()?;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len() + chunk.len() > 12 * 1024 * 1024 {
            return Ok(failure("ANALYTICS_RESPONSE_INVALID", true));
        }
        bytes.extend(chunk);
    }
    Ok(serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| failure("ANALYTICS_RESPONSE_INVALID", true)))
}

pub async fn query(env: &Env, args: &Value, samples: bool) -> Result<Value> {
    let start = args["start"].as_i64().unwrap();
    let end = args["end"].as_i64().unwrap();
    let now = store::now();
    if start >= end || start < now - WINDOW || end > now {
        return Ok(failure("INVALID_TIME_RANGE", false));
    }
    let zone = args["timezone"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            env.var("DEFAULT_TIMEZONE")
                .map(|v| v.to_string())
                .unwrap_or_else(|_| "Asia/Shanghai".into())
        });
    if !valid_timezone(&zone) {
        return Ok(failure("INVALID_TIMEZONE", false));
    }
    let (Ok(dataset), Ok(account), Ok(token)) = (
        env.var("ANALYTICS_DATASET"),
        env.var("CLOUDFLARE_ACCOUNT_ID"),
        env.secret("ANALYTICS_API_TOKEN"),
    ) else {
        return Ok(failure("ANALYTICS_NOT_CONFIGURED", false));
    };
    let (dataset, account, token) = (dataset.to_string(), account.to_string(), token.to_string());
    if dataset.is_empty()
        || dataset.len() > 128
        || !dataset
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        || dataset.as_bytes()[0].is_ascii_digit()
        || account.len() != 32
        || !account.bytes().all(|b| b.is_ascii_hexdigit())
        || token.is_empty()
    {
        return Ok(failure("ANALYTICS_NOT_CONFIGURED", false));
    }
    let granularity = args["granularity"].as_str().unwrap_or("day");
    let view = if samples {
        "samples"
    } else {
        args["view"].as_str().unwrap()
    };
    if !samples
        && ((view != "trend" && args.get("granularity").is_some())
            || (matches!(view, "summary" | "trend") && args.get("limit").is_some()))
    {
        return Ok(store::failure("INVALID_ARGUMENTS", "analytics", false));
    }
    let limit = args["limit"].as_u64().unwrap_or(20) as usize;
    let mut filters = format!("{TIME} >= {start} AND {TIME} < {end}");
    for (key, column) in [
        ("resource_id", "index1"),
        ("kind", KIND),
        ("referer", REFERER),
        ("country", COUNTRY),
        ("region", REGION),
        ("city", CITY),
    ] {
        if let Some(value) = args[key].as_str() {
            // Hex encoding avoids interpolating quotes, backslashes or control characters.
            filters.push_str(&format!(
                " AND hex({column}) = '{}'",
                hex::encode_upper(value.as_bytes())
            ));
        }
    }
    let mut cursor_args = args.clone();
    cursor_args["timezone"] = json!(zone);
    cursor_args["order"] = json!("time_desc_event_id_desc");
    if samples {
        match store::decode_cursor(&cursor_args, "stats.samples.v1") {
            Ok(Some((time, id)))
                if time >= start
                    && time < end
                    && id.len() == 12
                    && id.bytes().all(|b| b.is_ascii_alphanumeric()) =>
            {
                filters.push_str(&format!(
                    " AND ({TIME} < {time} OR ({TIME} = {time} AND {EVENT} < '{id}'))"
                ))
            }
            Ok(None) => {}
            _ => return Ok(store::failure("INVALID_CURSOR", "analytics", false)),
        }
    }
    let (select, suffix, max_rows) = match view {
        "samples" => (
            format!(
                "{EVENT} AS event_id, {RESOURCE} AS resource_id, {KIND} AS kind, {TIME} AS time, {STATUS} AS status, {REFERER} AS referer, {COUNTRY} AS country, {REGION} AS region, {CITY} AS city, _sample_interval"
            ),
            format!("ORDER BY {TIME} DESC, {EVENT} DESC LIMIT {}", limit + 1),
            limit + 1,
        ),
        "summary" => ("SUM(_sample_interval) AS visits".into(), "".into(), 1),
        "trend" => (
            format!(
                "toUnixTimestamp(toStartOfInterval(toDateTime({TIME}), INTERVAL '1' {}, '{zone}')) AS bucket_start, SUM(_sample_interval) AS visits",
                if granularity == "hour" { "HOUR" } else { "DAY" }
            ),
            "GROUP BY bucket_start ORDER BY bucket_start ASC LIMIT 750".into(),
            750,
        ),
        "referrers" => (
            format!("{REFERER} AS referer, SUM(_sample_interval) AS visits"),
            format!("GROUP BY {REFERER} ORDER BY visits DESC, {REFERER} ASC LIMIT {limit}"),
            limit,
        ),
        "regions" => (
            format!(
                "{COUNTRY} AS country, {REGION} AS region, {CITY} AS city, SUM(_sample_interval) AS visits"
            ),
            format!(
                "GROUP BY {COUNTRY}, {REGION}, {CITY} ORDER BY visits DESC, {COUNTRY} ASC, {REGION} ASC, {CITY} ASC LIMIT {limit}"
            ),
            limit,
        ),
        "top" => (
            format!("{RESOURCE} AS resource_id, {KIND} AS kind, SUM(_sample_interval) AS visits"),
            format!(
                "GROUP BY {RESOURCE}, {KIND} ORDER BY visits DESC, {RESOURCE} ASC, {KIND} ASC LIMIT {limit}"
            ),
            limit,
        ),
        _ => return Ok(store::failure("INVALID_ARGUMENTS", "analytics", false)),
    };
    let result = match sql_request(
        &account,
        &token,
        format!("SELECT {select} FROM {dataset} WHERE {filters} {suffix} FORMAT JSON"),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            console_error!("ANALYTICS_QUERY_TRANSPORT_FAILED");
            return Ok(failure("ANALYTICS_QUERY_FAILED", true));
        }
    };
    if result.get("error").is_some() {
        let code = match result["error"]["code"].as_str() {
            Some("ANALYTICS_RESPONSE_INVALID") => "ANALYTICS_RESPONSE_INVALID",
            _ => "ANALYTICS_QUERY_FAILED",
        };
        return Ok(failure(code, true));
    }
    let Some(mut items) = result["data"]
        .as_array()
        .cloned()
        .filter(|rows| rows.len() <= max_rows)
    else {
        return Ok(failure("ANALYTICS_RESPONSE_INVALID", true));
    };
    if view == "summary" && items.len() != 1 {
        return Ok(failure("ANALYTICS_RESPONSE_INVALID", true));
    }
    for item in &mut items {
        if !item.is_object() {
            return Ok(failure("ANALYTICS_RESPONSE_INVALID", true));
        }
        let numeric = if samples {
            vec!["time", "status", "_sample_interval"]
        } else if view == "trend" {
            vec!["bucket_start", "visits"]
        } else {
            vec!["visits"]
        };
        for key in numeric {
            let number = item[key]
                .as_f64()
                .or_else(|| item[key].as_str().and_then(|v| v.parse::<f64>().ok()));
            let Some(number) = number.filter(|v| {
                v.is_finite() && *v >= 0.0 && *v <= 9007199254740991.0 && v.fract() == 0.0
            }) else {
                return Ok(failure("ANALYTICS_RESPONSE_INVALID", true));
            };
            if key == "_sample_interval" && number < 1.0 {
                return Ok(failure("ANALYTICS_RESPONSE_INVALID", true));
            }
            item[key] = json!(number as u64);
        }
        if samples
            && (!item["event_id"]
                .as_str()
                .is_some_and(|id| id.len() == 12 && id.bytes().all(|b| b.is_ascii_alphanumeric()))
                || item["time"].as_i64().is_none_or(|t| t < start || t >= end))
        {
            return Ok(failure("ANALYTICS_RESPONSE_INVALID", true));
        }
        let text_fields: &[&str] = match view {
            "samples" => &[
                "resource_id",
                "kind",
                "referer",
                "country",
                "region",
                "city",
            ],
            "top" => &["resource_id", "kind"],
            "referrers" => &["referer"],
            "regions" => &["country", "region", "city"],
            _ => &[],
        };
        if text_fields.iter().any(|key| !item[*key].is_string()) {
            return Ok(failure("ANALYTICS_RESPONSE_INVALID", true));
        }
        if matches!(view, "samples" | "top")
            && (!item["resource_id"]
                .as_str()
                .is_some_and(|id| id.len() == 12 && id.bytes().all(|b| b.is_ascii_alphanumeric()))
                || !matches!(item["kind"].as_str(), Some("url" | "image" | "file")))
        {
            return Ok(failure("ANALYTICS_RESPONSE_INVALID", true));
        }
        item.as_object_mut().unwrap().retain(|key, _| {
            matches!(
                key.as_str(),
                "event_id"
                    | "resource_id"
                    | "kind"
                    | "time"
                    | "status"
                    | "referer"
                    | "country"
                    | "region"
                    | "city"
                    | "_sample_interval"
                    | "bucket_start"
                    | "visits"
            )
        });
        for key in ["referer", "country", "region", "city"] {
            if item.get(key).is_some_and(|v| v == "") {
                item[key] = Value::Null;
            }
        }
    }
    let has_more = samples && items.len() > limit;
    if has_more {
        items.truncate(limit);
    }
    let next_cursor = if has_more {
        let last = items.last().unwrap();
        Some(store::encode_cursor(
            &cursor_args,
            "stats.samples.v1",
            last["time"].as_i64().unwrap(),
            last["event_id"].as_str().unwrap(),
        )?)
    } else {
        None
    };
    // A single bounded D1 lookup includes deleted resources. Metadata failure
    // must not discard events or change the Analytics Engine weighted counts.
    let mut ids = std::collections::BTreeSet::new();
    for item in &items {
        if let Some(id) = item["resource_id"].as_str() {
            ids.insert(id.to_owned());
        }
    }
    if let Some(id) = args["resource_id"].as_str() {
        ids.insert(id.to_owned());
    }
    let mut metadata = std::collections::BTreeMap::new();
    let mut metadata_unknown = false;
    if !ids.is_empty() {
        let lookup = async {
            let placeholders = vec!["?"; ids.len()].join(",");
            let values: Vec<JsValue> = ids.iter().map(|id| JsValue::from_str(id)).collect();
            env.d1("DB")?
                .prepare(format!(
                    "SELECT id,title,state FROM resources WHERE id IN ({placeholders})"
                ))
                .bind(&values)?
                .all()
                .await?
                .results::<Value>()
        }
        .await;
        match lookup {
            Ok(rows) => {
                for row in rows {
                    if let Some(id) = row["id"].as_str() {
                        metadata.insert(id.to_owned(), row);
                    }
                }
            }
            Err(_) => metadata_unknown = true,
        }
    }
    for item in &mut items {
        if let Some(id) = item["resource_id"].as_str() {
            item["resource"] = metadata
                .get(id)
                .cloned()
                .unwrap_or_else(|| json!({"id":id,"title":null,"state":"unknown"}));
        }
    }
    let resource = args["resource_id"].as_str().map(|id| {
        metadata
            .get(id)
            .cloned()
            .unwrap_or_else(|| json!({"id":id,"title":null,"state":"unknown"}))
    });
    Ok(
        json!({"resource":resource,"view":view,"start":start,"end":end,"timezone":zone,"granularity":if view=="trend" {Some(granularity)} else {None},"items":items,"has_more":has_more,"next_cursor":next_cursor,"sampling":"Cloudflare-managed; weighted estimates; no fixed error bound","completeness":"unknown","diagnostics":if metadata_unknown {vec!["RESOURCE_METADATA_UNAVAILABLE"]} else {vec![]},"pagination":"Platform samples may change between pages; no snapshot or complete visit log"}),
    )
}
