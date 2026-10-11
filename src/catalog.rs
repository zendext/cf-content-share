use serde_json::{Value, json};

#[derive(Clone, Copy)]
pub enum Action {
    StatsQuery,
    StatsSamples,
    CreateUrl,
    ListResources,
    GetResource,
    UpdateResource,
    DeleteResource,
    ListOperations,
    GetOperation,
    RetryOperation,
    CreateSession,
    ListSessions,
    RevokeSession,
    Storage,
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

fn stats_schema(samples: bool) -> Value {
    let mut properties = json!({"start":{"type":"integer","minimum":0,"maximum":9007199254740991u64},"end":{"type":"integer","minimum":0,"maximum":9007199254740991u64},"timezone":{"type":"string","minLength":1,"maxLength":128},"resource_id":resource_id(),"kind":{"type":"string","enum":["url","image","file"]},"limit":{"type":"integer","minimum":1,"maximum":100,"default":20}});
    if samples {
        for key in ["referer", "country", "region", "city"] {
            properties[key] = string(16384);
        }
        properties["cursor"] = json!({"type":"string","minLength":1,"maxLength":2048});
        schema(properties, &["start", "end"])
    } else {
        properties["view"] =
            json!({"type":"string","enum":["summary","trend","referrers","regions","top"]});
        properties["granularity"] = json!({"type":"string","enum":["hour","day"],"default":"day"});
        schema(properties, &["start", "end", "view"])
    }
}

// Discovery, input validation and dispatch use this one catalog.
pub fn definitions() -> Vec<Definition> {
    vec![
        Definition {
            operation: Action::StatsQuery,
            name: "stats.query",
            description: "查询加权访问汇总、趋势、来源、地区和热门资源",
            schema: stats_schema(false),
            result: "items 与实际 start/end/timezone/granularity；加权估算，采集完整性未知",
            side_effects: "只读 Analytics Engine，D1 补充资源状态",
            example: json!({"view":"summary","start":1791676800,"end":1791763200}),
        },
        Definition {
            operation: Action::StatsSamples,
            name: "stats.samples",
            description: "分页查询平台可获取的访问样本",
            schema: stats_schema(true),
            result: "items 保留原始 Referer、地区和 _sample_interval；has_more 不代表全部访问或快照",
            side_effects: "只读；游标绑定窗口和所有筛选",
            example: json!({"start":1791676800,"end":1791763200,"limit":20}),
        },
        Definition {
            operation: Action::CreateSession,
            name: "session.create",
            description: "建立 24 小时多文件上传会话",
            schema: schema(json!({"client":string(256)}), &[]),
            result: "session_id、仅本次返回的 token、created_at、expires_at、HTTP 上传协议与 metadata Schema",
            side_effects: "只持久保存 Token 摘要；OAuth 撤销不自动撤销会话",
            example: json!({"client":"Codex"}),
        },
        Definition {
            operation: Action::ListSessions,
            name: "session.list",
            description: "分页列出上传会话；不返回凭据",
            schema: page(json!({})),
            result: "items、has_more、next_cursor",
            side_effects: "无",
            example: json!({"limit":20}),
        },
        Definition {
            operation: Action::RevokeSession,
            name: "session.revoke",
            description: "撤销会话，拒绝新的上传",
            schema: schema(json!({"session_id":identifier()}), &["session_id"]),
            result: "撤销后的会话信息",
            side_effects: "已受理上传仍可收尾",
            example: json!({"session_id":"session-id"}),
        },
        Definition {
            operation: Action::Storage,
            name: "storage.get",
            description: "查询容量计数与可选限制",
            schema: schema(json!({}), &[]),
            result: "published_bytes、reserved_bytes、cleanup_bytes、total_storage_bytes、max_file_bytes；null 表示无产品限制",
            side_effects: "无",
            example: json!({}),
        },
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
                json!({"keyword":string(512),"filename":string(1024),"kind":{"type":"string","enum":["url","image","file"],"description":"url, image, or other file"},"tags":tags(),"created_from":{"type":"integer","minimum":0,"maximum":9007199254740991u64},"created_to":{"type":"integer","minimum":0,"maximum":9007199254740991u64}}),
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
            description: "重新安排可由服务端完成的恢复步骤",
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

pub fn upload_schema() -> Value {
    schema(
        json!({"operation_id":identifier(),"filename":{"type":"string","minLength":1,"maxLength":1024},"content_type":{"type":"string","minLength":1,"maxLength":255},"size_bytes":{"type":"integer","minimum":0,"maximum":9007199254740991u64},"sha256":{"type":"string","minLength":64,"maxLength":64},"title":string(512),"description":string(8192),"tags":tags()}),
        &[
            "operation_id",
            "filename",
            "content_type",
            "size_bytes",
            "sha256",
        ],
    )
}
