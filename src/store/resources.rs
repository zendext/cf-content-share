use super::{IdRow, Resource, ResourceKind};
use serde_json::Value;
use wasm_bindgen::JsValue;
use worker::*;

pub async fn get(db: &D1Database, id: &str) -> Result<Option<Resource>> {
    // Non-session D1 bindings always use the primary, including with read replication enabled.
    db.prepare("SELECT * FROM resources WHERE id=?")
        .bind(&[id.into()])?
        .first(None)
        .await
}

pub async fn expire_if_due(db: &D1Database, id: &str, operation_id: &str) -> Result<()> {
    // Recheck the deadline inside the same transaction that registers deletion.
    let resource_write = db
        .prepare(
            r#"
        UPDATE resources
        SET state='deleted',
            deleted_reason='expired',
            deleted_at=unixepoch(),
            target_url=NULL,
            description='',
            tags='[]',
            accounting=CASE WHEN accounting='published' THEN 'cleanup' ELSE accounting END
        WHERE id=?
          AND state IN ('pending','published')
          AND expires_at<=unixepoch()
        "#,
        )
        .bind(&[id.into()])?;
    let operation_write = db
        .prepare(
            r#"
        INSERT INTO operations (
            id, type, resource_id, fingerprint, created_at, updated_at, next_retry_at,
            r2_status)
        SELECT ?,'resource.delete',id,'expiration',unixepoch(),unixepoch(),unixepoch(),CASE
                WHEN kind='url' THEN 'none'
                ELSE 'pending' END
        FROM resources
        WHERE id=?
          AND changes()>0
        "#,
        )
        .bind(&[operation_id.into(), id.into()])?;
    db.batch(vec![resource_write, operation_write]).await?;

    Ok(())
}

pub async fn list_expired_ids(db: &D1Database) -> Result<Vec<String>> {
    let rows = db
        .prepare(
            r#"
        SELECT id
        FROM resources
        WHERE state IN ('pending','published')
          AND expires_at IS NOT NULL
          AND expires_at<=unixepoch()
        ORDER BY expires_at,id
        LIMIT 25
        "#,
        )
        .all()
        .await?
        .results::<IdRow>()?;

    Ok(rows.into_iter().map(|row| row.id).collect())
}

pub async fn create_url(
    db: &D1Database,
    id: &str,
    resource_id: &str,
    metadata: &Value,
    fingerprint: &str,
    now: i64,
) -> Result<()> {
    let now = now as f64;
    let resource_write = db
        .prepare(
            r#"
        INSERT INTO resources (
            id, kind, state, target_url, title, description, tags, created_at,
            expiration_policy_version, retention_seconds)
        VALUES(?,'url','published',?,?,?,?,?,1,?)
        "#,
        )
        .bind(&[
            resource_id.into(),
            metadata["target_url"].as_str().unwrap().into(),
            metadata["title"].as_str().unwrap().into(),
            metadata["description"].as_str().unwrap().into(),
            metadata["tags"].to_string().into(),
            now.into(),
            metadata["retention_seconds"]
                .as_i64()
                .map(|n| JsValue::from(n as f64))
                .unwrap_or(JsValue::NULL),
        ])?;
    let operation_write = db
        .prepare(
            r#"
        INSERT INTO operations (
            id, type, resource_id, fingerprint, created_at, updated_at, next_retry_at,
            fingerprint_version)
        VALUES(?,'resource.create_url',?,?,?,?,?,1)
        "#,
        )
        .bind(&[
            id.into(),
            resource_id.into(),
            fingerprint.into(),
            now.into(),
            now.into(),
            now.into(),
        ])?;
    db.batch(vec![resource_write, operation_write]).await?;

    Ok(())
}

pub async fn update_with_operation(
    db: &D1Database,
    args: &Value,
    resource: &Resource,
    operation_id: &str,
    delete: bool,
    now: i64,
) -> Result<()> {
    let id = &resource.id;
    let now = now as f64;
    let statement = if delete {
        db.prepare(
            r#"
        UPDATE resources
        SET state='deleted',
            target_url=NULL,
            description='',
            tags='[]',
            deleted_at=?,
            deleted_reason='manual',
            accounting=CASE WHEN accounting='published' THEN 'cleanup' ELSE accounting END
        WHERE id=?
          AND state IN ('pending','published')
        "#,
        )
        .bind(&[now.into(), id.into()])?
    } else {
        let optional = |key: &str| {
            args[key]
                .as_str()
                .map(JsValue::from)
                .unwrap_or(JsValue::NULL)
        };
        db.prepare(
            r#"
        UPDATE resources
        SET target_url=COALESCE(?,target_url),
            title=COALESCE(?,title),
            description=COALESCE(?,description),
            tags=COALESCE(?,tags),
            expires_at=CASE WHEN ? THEN ? ELSE expires_at END
        WHERE id=?
          AND state='published'
          AND (expires_at IS NULL OR expires_at>unixepoch())
          AND (? IS NULL OR ?>unixepoch())
        "#,
        )
        .bind(&[
            optional("target_url"),
            optional("title"),
            optional("description"),
            args.get("tags")
                .map(|tags| JsValue::from(tags.to_string()))
                .unwrap_or(JsValue::NULL),
            args.get("expires_at").is_some().into(),
            args["expires_at"]
                .as_i64()
                .map(|n| JsValue::from(n as f64))
                .unwrap_or(JsValue::NULL),
            id.into(),
            args["expires_at"]
                .as_i64()
                .map(|n| JsValue::from(n as f64))
                .unwrap_or(JsValue::NULL),
            args["expires_at"]
                .as_i64()
                .map(|n| JsValue::from(n as f64))
                .unwrap_or(JsValue::NULL),
        ])?
    };
    let operation_write = db
        .prepare(
            r#"
        INSERT INTO operations (
            id, type, resource_id, fingerprint, created_at, updated_at, next_retry_at,
            r2_status)
        SELECT ?,?,?,?,?,?,?,?
        WHERE changes()>0
        "#,
        )
        .bind(&[
            operation_id.into(),
            (if delete {
                "resource.delete"
            } else {
                "resource.update"
            })
            .into(),
            id.into(),
            super::fingerprint(args).into(),
            now.into(),
            now.into(),
            now.into(),
            (if delete && resource.kind != ResourceKind::Url {
                "pending"
            } else {
                "none"
            })
            .into(),
        ])?;
    db.batch(vec![statement, operation_write]).await?;

    Ok(())
}

pub async fn list_rows(
    db: &D1Database,
    args: &Value,
    operations: bool,
    cursor: Option<(i64, String)>,
    limit: usize,
) -> Result<Vec<Value>> {
    let mut sql = if operations {
        "SELECT * FROM operations WHERE 1=1"
    } else {
        r#"
        SELECT *
        FROM resources
        WHERE state='published'
          AND (expires_at IS NULL OR expires_at>unixepoch())
        "#
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
    let rows = db
        .prepare(sql)
        .bind(&bindings)?
        .all()
        .await?
        .results::<Value>()?;

    Ok(rows)
}

pub async fn analytics_metadata(
    db: &D1Database,
    ids: &std::collections::BTreeSet<String>,
) -> Result<Vec<Value>> {
    let placeholders = vec!["?"; ids.len()].join(",");
    let values: Vec<JsValue> = ids.iter().map(|id| JsValue::from_str(id)).collect();
    db.prepare(format!(
        r#"
        SELECT id,title,state,expires_at,published_at,deleted_reason,CASE
                WHEN state='published'
                AND (expires_at IS NULL
                OR expires_at>unixepoch()) THEN 1
                ELSE 0 END AS accessible,CASE
                WHEN state='deleted' THEN CASE
                WHEN deleted_reason='expired' THEN 'expired'
                ELSE 'deleted' END
                WHEN expires_at<=unixepoch() THEN 'expired'
                WHEN state='pending' THEN 'pending'
                ELSE NULL END AS unavailable_reason
        FROM resources
        WHERE id IN ({placeholders})
        "#
    ))
    .bind(&values)?
    .all()
    .await?
    .results::<Value>()
}
