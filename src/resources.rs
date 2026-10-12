use crate::{auth, recovery, store};
use serde_json::{Value, json};
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
    let (fingerprint, legacy_fingerprint) = store::creation_fingerprints(&mut metadata);
    let db = env.d1("DB")?;
    for _ in 0..5 {
        if let Some(op) = store::operations::get(&env.d1("DB")?, id).await? {
            return if op.r#type == store::OperationType::CreateUrl
                && (if op.fingerprint_version == 0 {
                    legacy_fingerprint.as_ref() == Some(&op.fingerprint)
                } else {
                    op.fingerprint == fingerprint
                }) {
                store::operation_result(env, id).await
            } else {
                Ok(store::failure("IDEMPOTENCY_CONFLICT", "create", false))
            };
        }
        if !store::valid_retention(&metadata) {
            return Ok(store::failure("INVALID_ARGUMENTS", "validation", false));
        }
        let resource_id = store::resource_id()?;
        let now = store::now();
        let result =
            store::resources::create_url(&db, id, &resource_id, &metadata, &fingerprint, now).await;
        if let Err(error) = result {
            // Unique operation races roll the entire batch back. Query before deciding to retry.
            if store::operations::get(&env.d1("DB")?, id).await?.is_some() {
                continue;
            }
            if store::resources::get(&env.d1("DB")?, &resource_id)
                .await?
                .is_some()
            {
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
    let Some(resource) = store::resources::get(&env.d1("DB")?, id).await? else {
        return Ok(store::failure("NOT_FOUND", "lookup", false));
    };
    let op = store::operations::latest_for_resource(&env.d1("DB")?, id).await?;
    Ok(json!({"resource":resource.output(env)?,"operation":op.map(|op|op.output())}))
}

pub async fn update(env: &Env, args: &Value, delete: bool) -> Result<Value> {
    let id = args["resource_id"].as_str().unwrap();
    let Some(resource) = store::resources::get(&env.d1("DB")?, id).await? else {
        return Ok(store::failure("NOT_FOUND", "lookup", false));
    };
    if resource.state == store::ResourceState::Deleted {
        return if delete {
            get(env, id).await
        } else {
            Ok(store::failure("RESOURCE_DELETED", "update", false))
        };
    }
    if !delete && resource.expired() {
        return Ok(store::failure("RESOURCE_EXPIRED", "update", false));
    }
    if !delete
        && args
            .get("expires_at")
            .and_then(Value::as_i64)
            .is_some_and(|time| time <= store::now())
    {
        return Ok(store::failure("INVALID_ARGUMENTS", "validation", false));
    }
    if !delete && args.as_object().unwrap().len() == 1 {
        return Ok(store::failure("INVALID_ARGUMENTS", "validation", false));
    }
    if !delete && args.get("target_url").is_some() && resource.kind != store::ResourceKind::Url {
        return Ok(store::failure("IMMUTABLE_FILE", "update", false));
    }
    let db = env.d1("DB")?;
    let operation_id = auth::random_token()?;
    let now = store::now();
    store::resources::update_with_operation(&db, args, &resource, &operation_id, delete, now)
        .await?;
    if store::operations::get(&env.d1("DB")?, &operation_id)
        .await?
        .is_none()
    {
        if delete {
            return get(env, id).await;
        }
        let current = store::resources::get(&env.d1("DB")?, id).await?;
        let code = match current {
            Some(resource) if resource.state == store::ResourceState::Deleted => "RESOURCE_DELETED",
            Some(resource) if resource.expired() => "RESOURCE_EXPIRED",
            Some(_) => "INVALID_ARGUMENTS",
            None => "NOT_FOUND",
        };
        return Ok(store::failure(code, "update", false));
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
    if !operations
        && let (Some(from), Some(to)) = (args["created_from"].as_u64(), args["created_to"].as_u64())
        && from >= to
    {
        return Ok(store::failure("INVALID_TIME_RANGE", "validation", false));
    }
    let mut rows =
        store::resources::list_rows(&env.d1("DB")?, args, operations, cursor, limit).await?;
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
