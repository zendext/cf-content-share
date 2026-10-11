use serde_json::{Value, json};

#[derive(Clone, Copy)]
pub enum Action {
    CreateUrl,
    ListResources,
    GetResource,
    UpdateResource,
    DeleteResource,
    ListOperations,
    GetOperation,
    RetryOperation,
}

pub struct Definition {
    pub operation: Action,
    pub name: &'static str,
    pub description: &'static str,
    pub schema: Value,
    pub result: &'static str,
    pub side_effects: &'static str,
    pub example: Value,
}

fn string(max: u64) -> Value {
    json!({"type":"string","maxLength":max})
}
fn identifier() -> Value {
    json!({"type":"string","minLength":1,"maxLength":128})
}
fn resource_id() -> Value {
    json!({"type":"string","minLength":12,"maxLength":12,"format":"resource-id"})
}
fn tags() -> Value {
    json!({"type":"array","maxItems":32,"uniqueItems":true,"items":{"type":"string","minLength":1,"maxLength":128}})
}
fn schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
fn page(mut properties: Value) -> Value {
    properties["limit"] = json!({"type":"integer","minimum":1,"maximum":100,"default":20});
    properties["cursor"] = json!({"type":"string","minLength":1,"maxLength":2048});
    schema(properties, &[])
}

// Discovery, input validation and dispatch use this one catalog.
pub fn definitions() -> Vec<Definition> {
    vec![
        Definition {
            operation: Action::CreateUrl,
            name: "resource.create_url",
            description: "幂等创建 12 位短链",
            schema: schema(
                json!({"operation_id":identifier(),"target_url":{"type":"string","minLength":1,"maxLength":8192,"format":"http-url"},"title":string(512),"description":string(8192),"tags":tags()}),
                &["operation_id", "target_url"],
            ),
            result: "resource 与 operation；相同创建参数返回原资源的当前状态",
            side_effects: "D1 原子创建，随后尝试 KV 同步；不抓取目标网址",
            example: json!({"operation_id":"client-unique-id","target_url":"https://example.com/","tags":["资料"]}),
        },
        Definition {
            operation: Action::ListResources,
            name: "resource.list",
            description: "分页搜索已发布资源",
            schema: page(
                json!({"keyword":string(512),"kind":{"type":"string","enum":["url"]},"tags":tags(),"created_from":{"type":"integer","minimum":0,"maximum":9007199254740991u64},"created_to":{"type":"integer","minimum":0,"maximum":9007199254740991u64}}),
            ),
            result: "items、has_more、next_cursor；created_at 和 id 倒序，时间为 UTC Unix 秒，区间 [from,to)",
            side_effects: "无；多个标签全部匹配，游标绑定筛选条件",
            example: json!({"keyword":"资料","limit":20}),
        },
        Definition {
            operation: Action::GetResource,
            name: "resource.get",
            description: "查询资源当前详情与相关操作入口",
            schema: schema(json!({"resource_id":resource_id()}), &["resource_id"]),
            result: "resource、最新 operation；其他记录通过 operation.list(resource_id) 分页查询",
            side_effects: "无；包含删除状态",
            example: json!({"resource_id":"aB3kP9mR2xQ7"}),
        },
        Definition {
            operation: Action::UpdateResource,
            name: "resource.update",
            description: "编辑目标 URL 或管理元数据",
            schema: schema(
                json!({"resource_id":resource_id(),"target_url":{"type":"string","minLength":1,"maxLength":8192,"format":"http-url"},"title":string(512),"description":string(8192),"tags":tags()}),
                &["resource_id"],
            ),
            result: "resource 与持久化的 KV 同步 operation",
            side_effects: "最后成功写入生效；空字符串或空标签数组用于清空字段；拒绝编辑已删除资源",
            example: json!({"resource_id":"aB3kP9mR2xQ7","title":"新标题"}),
        },
        Definition {
            operation: Action::DeleteResource,
            name: "resource.delete",
            description: "永久逻辑删除资源",
            schema: schema(json!({"resource_id":resource_id()}), &["resource_id"]),
            result: "resource.state=deleted 与 operation；kv=accepted 仅表示平台已接受更新",
            side_effects: "保留 ID 和幂等映射；不能恢复资源；公开映射最终一致",
            example: json!({"resource_id":"aB3kP9mR2xQ7"}),
        },
        Definition {
            operation: Action::ListOperations,
            name: "operation.list",
            description: "分页查询持久操作和重试状态",
            schema: page(
                json!({"status":{"type":"string","enum":["pending","running","retry_pending","completed","needs_attention"]},"resource_id":resource_id()}),
            ),
            result: "items、has_more、next_cursor；包含步骤、最后错误和累计尝试数",
            side_effects: "无",
            example: json!({"status":"needs_attention","limit":20}),
        },
        Definition {
            operation: Action::GetOperation,
            name: "operation.get",
            description: "查询结果不明的操作",
            schema: schema(json!({"operation_id":identifier()}), &["operation_id"]),
            result: "operation 与资源当前状态，不重放旧资源数据",
            side_effects: "无",
            example: json!({"operation_id":"client-unique-id"}),
        },
        Definition {
            operation: Action::RetryOperation,
            name: "operation.retry",
            description: "重新安排未完成的 KV 同步",
            schema: schema(json!({"operation_id":identifier()}), &["operation_id"]),
            result: "当前 operation；已完成或仍有有效执行占用时不重置",
            side_effects: "开始新一轮最多 10 次自动重试；保留累计尝试数与最后失败信息；不撤销删除",
            example: json!({"operation_id":"client-unique-id"}),
        },
    ]
}

// Only the JSON Schema subset emitted above is accepted. Unknown fields and nulls fail closed.
pub fn validate(schema: &Value, value: &Value) -> bool {
    if let Some(options) = schema["enum"].as_array()
        && !options.contains(value)
    {
        return false;
    }
    match schema["type"].as_str() {
        Some("object") => {
            let Some(values) = value.as_object() else {
                return false;
            };
            let Some(properties) = schema["properties"].as_object() else {
                return false;
            };
            let required = schema["required"].as_array();
            required.is_none_or(|keys| {
                keys.iter()
                    .all(|key| value.get(key.as_str().unwrap()).is_some())
            }) && values.iter().all(|(key, value)| {
                properties
                    .get(key)
                    .is_some_and(|schema| validate(schema, value))
            })
        }
        Some("string") => {
            let Some(text) = value.as_str() else {
                return false;
            };
            let length = text.chars().count() as u64;
            if length < schema["minLength"].as_u64().unwrap_or(0)
                || length > schema["maxLength"].as_u64().unwrap_or(u64::MAX)
                || text
                    .chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\t')
            {
                return false;
            }
            match schema["format"].as_str() {
                Some("resource-id") => text.bytes().all(|b| b.is_ascii_alphanumeric()),
                Some("http-url") => {
                    !text.chars().any(char::is_whitespace)
                        && worker::Url::parse(text).is_ok_and(|url| {
                            matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
                        })
                }
                _ => true,
            }
        }
        Some("integer") => value.as_u64().is_some_and(|number| {
            number >= schema["minimum"].as_u64().unwrap_or(0)
                && number <= schema["maximum"].as_u64().unwrap_or(u64::MAX)
        }),
        Some("array") => value.as_array().is_some_and(|items| {
            items.len() as u64 <= schema["maxItems"].as_u64().unwrap_or(u64::MAX)
                && items.iter().enumerate().all(|(i, item)| {
                    validate(&schema["items"], item)
                        && (schema["uniqueItems"] != true || !items[..i].contains(item))
                })
        }),
        _ => false,
    }
}
