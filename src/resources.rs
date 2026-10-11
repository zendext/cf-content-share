use crate::{auth, recovery, store};
use serde_json::{Value, json};
use wasm_bindgen::JsValue;
use worker::*;

pub async fn create(env: &Env, args: &Value) -> Result<Value> {
    let id = args["operation_id"].as_str().unwrap();
    let mut metadata = args.clone();
    metadata.as_object_mut().unwrap().remove("operation_id");
    for key in ["title", "description"] {
        if metadata.get(key).is_none() {
            metadata[key] = json!("");
        }
    }
    if metadata.get("tags").is_none() {
        metadata["tags"] = json!([]);
    }
    let fingerprint = store::fingerprint(&metadata);
    let db = env.d1("DB")?;
    for _ in 0..5 {
        if let Some(op) = store::operation(env, id).await? {
            return if op.r#type == "resource.create_url" && op.fingerprint == fingerprint {
                store::operation_result(env, id).await
            } else {
                Ok(store::failure("IDEMPOTENCY_CONFLICT", "create", false))
            };
        }
        let resource_id = store::resource_id()?;
        let now = store::now() as f64;
        let result = db.batch(vec![
            db.prepare("INSERT INTO resources(id,kind,state,target_url,title,description,tags,created_at) VALUES(?,'url','published',?,?,?,?,?)")
                .bind(&[resource_id.clone().into(), metadata["target_url"].as_str().unwrap().into(), metadata["title"].as_str().unwrap().into(), metadata["description"].as_str().unwrap().into(), metadata["tags"].to_string().into(), now.into()])?,
            db.prepare("INSERT INTO operations(id,type,resource_id,fingerprint,created_at,updated_at,next_retry_at) VALUES(?,'resource.create_url',?,?,?,?,?)")
                .bind(&[id.into(), resource_id.clone().into(), fingerprint.clone().into(), now.into(), now.into(), now.into()])?,
        ]).await;
        if let Err(error) = result {
            // Unique operation races roll the entire batch back. Query before deciding to retry.
            if store::operation(env, id).await?.is_some() {
                continue;
            }
            if store::resource(env, &resource_id).await?.is_some() {
                continue;
            }
            return Err(error);
        }
        // If acknowledgment persistence fails, the already registered task remains recoverable.
        let _ = recovery::sync(env, id, false).await;
        return store::operation_result(env, id).await;
    }
    Ok(store::failure("ID_ALLOCATION_RETRY", "create", true))
}

pub async fn get(env: &Env, id: &str) -> Result<Value> {
    let Some(resource) = store::resource(env, id).await? else {
        return Ok(store::failure("NOT_FOUND", "lookup", false));
    };
    let op = env
        .d1("DB")?
        .prepare("SELECT * FROM operations WHERE resource_id=? ORDER BY sequence DESC LIMIT 1")
        .bind(&[id.into()])?
        .first::<store::Operation>(None)
        .await?;
    Ok(json!({"resource":resource.output(env)?,"operation":op.map(|op|op.output())}))
}

pub async fn update(env: &Env, args: &Value, delete: bool) -> Result<Value> {
    let id = args["resource_id"].as_str().unwrap();
    let Some(resource) = store::resource(env, id).await? else {
        return Ok(store::failure("NOT_FOUND", "lookup", false));
    };
    if resource.state == "deleted" {
        return if delete {
            get(env, id).await
        } else {
            Ok(store::failure("RESOURCE_DELETED", "update", false))
        };
    }
    if !delete && args.as_object().unwrap().len() == 1 {
        return Ok(store::failure("INVALID_ARGUMENTS", "validation", false));
    }
    if !delete && args.get("target_url").is_some() && resource.kind != "url" {
        return Ok(store::failure("IMMUTABLE_FILE", "update", false));
    }
    let db = env.d1("DB")?;
    let operation_id = auth::random_token()?;
    let now = store::now() as f64;
    let statement = if delete {
        db.prepare("UPDATE resources SET state='deleted', target_url=NULL, description='', tags='[]', deleted_at=?, accounting=CASE WHEN accounting='published' THEN 'cleanup' ELSE accounting END WHERE id=? AND state IN ('pending','published')")
            .bind(&[now.into(), id.into()])?
    } else {
        let optional = |key: &str| {
            args[key]
                .as_str()
                .map(JsValue::from)
                .unwrap_or(JsValue::NULL)
        };
        db.prepare("UPDATE resources SET target_url=COALESCE(?,target_url), title=COALESCE(?,title), description=COALESCE(?,description), tags=COALESCE(?,tags) WHERE id=? AND state='published'")
            .bind(&[optional("target_url"), optional("title"), optional("description"), args.get("tags").map(|tags| JsValue::from(tags.to_string())).unwrap_or(JsValue::NULL), id.into()])?
    };
    db.batch(vec![statement,
        db.prepare("INSERT INTO operations(id,type,resource_id,fingerprint,created_at,updated_at,next_retry_at,r2_status) SELECT ?,?,?,?,?,?,?,? WHERE changes()>0")
            .bind(&[operation_id.clone().into(), (if delete {"resource.delete"} else {"resource.update"}).into(), id.into(), store::fingerprint(args).into(), now.into(), now.into(), now.into(), (if delete && resource.kind!="url" {"pending"} else {"none"}).into()])?,
    ]).await?;
    if store::operation(env, &operation_id).await?.is_none() {
        return if delete {
            get(env, id).await
        } else {
            Ok(store::failure("RESOURCE_DELETED", "update", false))
        };
    }
    let _ = recovery::sync(env, &operation_id, false).await;
    store::operation_result(env, &operation_id).await
}

pub async fn list(env: &Env, args: &Value, operations: bool) -> Result<Value> {
    let scope = if operations {
        "operations"
    } else {
        "resources"
    };
    let cursor = match store::decode_cursor(args, scope) {
        Ok(cursor) => cursor,
        Err(_) => return Ok(store::failure("INVALID_CURSOR", "pagination", false)),
    };
    let limit = args["limit"].as_u64().unwrap_or(20) as usize;
    let mut sql = if operations {
        "SELECT * FROM operations WHERE 1=1"
    } else {
        "SELECT * FROM resources WHERE state='published'"
    }
    .to_string();
    let mut bindings: Vec<JsValue> = Vec::new();
    for key in if operations {
        &["status", "resource_id"][..]
    } else {
        &["kind"][..]
    } {
        if let Some(value) = args[key].as_str() {
            sql.push_str(&format!(" AND {key}=?"));
            bindings.push(value.into());
        }
    }
    if !operations {
        if let Some(keyword) = args["keyword"].as_str() {
            let escaped = keyword
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            let pattern = format!("%{escaped}%");
            sql.push_str(" AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR filename LIKE ? ESCAPE '\\')");
            bindings.extend([
                pattern.clone().into(),
                pattern.clone().into(),
                pattern.into(),
            ]);
        }
        if let Some(filename) = args["filename"].as_str() {
            sql.push_str(" AND filename=?");
            bindings.push(filename.into());
        }
        if let Some(tags) = args["tags"].as_array() {
            for tag in tags {
                sql.push_str(" AND EXISTS (SELECT 1 FROM json_each(resources.tags) WHERE value=?)");
                bindings.push(tag.as_str().unwrap().into());
            }
        }
        if let (Some(from), Some(to)) = (args["created_from"].as_u64(), args["created_to"].as_u64())
            && from >= to
        {
            return Ok(store::failure("INVALID_TIME_RANGE", "validation", false));
        }
        for (key, comparison) in [("created_from", ">="), ("created_to", "<")] {
            if let Some(time) = args[key].as_u64() {
                sql.push_str(&format!(" AND created_at{comparison}?"));
                bindings.push((time as f64).into());
            }
        }
    }
    if let Some((time, id)) = cursor {
        sql.push_str(" AND (created_at<? OR (created_at=? AND id<?))");
        bindings.extend([(time as f64).into(), (time as f64).into(), id.into()]);
    }
    sql.push_str(" ORDER BY created_at DESC,id DESC LIMIT ?");
    bindings.push(((limit + 1) as f64).into());
    let mut rows = env
        .d1("DB")?
        .prepare(sql)
        .bind(&bindings)?
        .all()
        .await?
        .results::<Value>()?;
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let next = if has_more {
        let row = rows.last().unwrap();
        Some(store::encode_cursor(
            args,
            scope,
            row["created_at"].as_i64().unwrap(),
            row["id"].as_str().unwrap(),
        )?)
    } else {
        None
    };
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        items.push(if operations {
            serde_json::from_value::<store::Operation>(row)?.output()
        } else {
            let resource = serde_json::from_value::<store::Resource>(row)?;
            let mut value = resource.output(env)?;
            value.as_object_mut().unwrap().remove("description");
            value
        });
    }
    Ok(json!({"items":items,"has_more":has_more,"next_cursor":next}))
}
