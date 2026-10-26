use serde_json::{Value, json};

pub const MAX_METADATA_BYTES: u64 = 16384;

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
    UploadAuthorization,
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
fn retention() -> Value {
    json!({"type":["integer","null"],"minimum":1,"maximum":9007199254740991u64,"default":2592000,"description":"Initial lifetime in seconds from first successful publication. Omitted: 2592000 seconds (30 days). null: initially no automatic expiration. A positive integer must also keep publication time plus lifetime within 9007199254740991; the server checks this current-time constraint. Retries do not restart the lifetime. Later resource.update can change expires_at without changing this original creation policy; read resource.expires_at for the current deadline."})
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
            operation: Action::UploadAuthorization,
            name: "upload.authorization",
            description: "取得当前已登录 MCP 请求的 Cloudflare Access 凭据，用于验证共享授权上传",
            schema: schema(json!({}), &[]),
            result: "token 为本次已验证的 Access JWT；expires_at 来自 JWT；upload 为 HTTP 上传契约",
            side_effects: "不签发 Token、不保存会话；凭据具有 MCP 管理权限，必须保存为私有文件，不能输出或放入命令参数；尚未替换现有上传会话流程",
            example: json!({}),
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
                json!({"operation_id":identifier(),"target_url":{"type":"string","minLength":1,"maxLength":8192,"format":"http-url"},"title":string(512),"description":string(8192),"tags":tags(),"retention_seconds":retention()}),
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
                json!({"resource_id":resource_id(),"target_url":{"type":"string","minLength":1,"maxLength":8192,"format":"http-url"},"title":string(512),"description":string(8192),"tags":tags(),"expires_at":{"type":["integer","null"],"minimum":1,"maximum":9007199254740991u64,"description":"Current absolute deadline in UTC Unix seconds. Omit to keep unchanged; null removes automatic expiration; an integer must be strictly in the future when applied. Does not change retention_seconds. Cannot restore an expired or deleted resource."}}),
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

// Only the JSON Schema subset emitted above is accepted. Unknown fields and undeclared nulls fail closed.
pub fn validate(schema: &Value, value: &Value) -> bool {
    if let Some(options) = schema["enum"].as_array()
        && !options.contains(value)
    {
        return false;
    }
    if let Some(types) = schema["type"].as_array() {
        return types.iter().any(|kind| {
            let mut alternative = schema.clone();
            alternative["type"] = kind.clone();
            validate(&alternative, value)
        });
    }
    match schema["type"].as_str() {
        Some("null") => value.is_null(),
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
                Some("upload-filename") => !text.chars().any(char::is_control),
                Some("upload-content-type") => {
                    text.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-/".contains(&b))
                        && text.split('/').count() == 2
                        && !text.starts_with('/')
                        && !text.ends_with('/')
                }
                Some("sha256-lowercase") => text
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
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
    let mut properties = json!({
        "operation_id":identifier(),
        "filename":{"type":"string","minLength":1,"maxLength":1024,"format":"upload-filename","description":"Original download filename, 1–1024 Unicode characters; no control characters. Required; no default."},
        "content_type":{"type":"string","minLength":1,"maxLength":255,"format":"upload-content-type","pattern":"^[A-Za-z0-9!#$&^_.+\\-]+/[A-Za-z0-9!#$&^_.+\\-]+$","description":"Required MIME type/subtype without parameters or whitespace; each component uses ASCII letters, digits or !#$&^_.+-. Choose application/octet-stream when unknown. The server recognizes supported image MIME types; use the returned resource.kind as the authoritative classification."},
        "size_bytes":{"type":"integer","minimum":0,"maximum":9007199254740991u64,"description":"Exact local file length in bytes, generated by the uploader. storage.get exposes deployment file and capacity limits."},
        "sha256":{"type":"string","minLength":64,"maxLength":64,"format":"sha256-lowercase","pattern":"^[0-9a-f]{64}$","description":"SHA-256 of the exact file bytes, generated as 64 lowercase hexadecimal characters."},
        "title":string(512),"description":string(8192),"tags":tags(),"retention_seconds":retention()
    });
    properties["operation_id"]["description"] = json!(
        "Uploader-generated stable identifier, saved before transmission. Reuse the same ID and identical metadata/file bytes for recovery; changing parameters conflicts."
    );
    properties["title"]["description"] = json!(
        "Management title, at most 512 Unicode characters. Omit or use an empty string for no title; null is invalid."
    );
    properties["title"]["default"] = json!("");
    properties["description"]["description"] = json!(
        "Management description, at most 8192 Unicode characters. Omit or use an empty string for no description; null is invalid."
    );
    properties["description"]["default"] = json!("");
    properties["tags"]["description"] = json!(
        "Management tags: at most 32 distinct, case-sensitive strings, each 1–128 Unicode characters. Omit or use [] for no tags; null is invalid."
    );
    properties["tags"]["default"] = json!([]);
    let mut value = schema(
        properties,
        &[
            "operation_id",
            "filename",
            "content_type",
            "size_bytes",
            "sha256",
        ],
    );
    value["description"] = json!(
        "Upload metadata JSON. Unknown fields and undeclared nulls are rejected. String limits count Unicode characters; control characters other than newline and tab are rejected everywhere, and filenames reject all control characters. The entire UTF-8 JSON must fit max_metadata_bytes."
    );
    value["examples"] = json!([{"operation_id":"example-empty-file","filename":"empty.txt","content_type":"text/plain","size_bytes":0,"sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","title":"Empty file","description":"","tags":[]}]);
    value
}

// The upload response and operation.get share this envelope; extra fields remain compatible.
pub fn operation_result_schema() -> Value {
    let timestamp = json!({"type":"integer","description":"UTC Unix timestamp in seconds"});
    let nullable_timestamp = json!({"type":["integer","null"],"description":"UTC Unix timestamp in seconds, or null when unset"});
    let error = json!({"type":"object","required":["code","step","retryable","message"],"properties":{
        "code":{"type":"string"},"step":{"type":"string"},"retryable":{"type":"boolean"},"message":{"type":"string"}
    }});
    json!({"description":"Authoritative current operation.get structuredContent, also used by accepted HTTP uploads. An error envelope can occur before any operation exists.","oneOf":[
        {"type":"object","required":["resource","operation"],"properties":{
            "resource":{"type":"object","required":["id","kind","state","target_url","title","description","tags","created_at","deleted_at","file_key","filename","content_type","size_bytes","sha256","accounting","retention_seconds","published_at","expires_at","deleted_reason","accessible","unavailable_reason","share_url"],"properties":{
                "id":resource_id(),"kind":{"type":"string","enum":["url","image","file"]},"state":{"type":"string","enum":["pending","published","deleted"]},
                "target_url":{"type":["string","null"]},"title":{"type":"string"},"description":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}},
                "created_at":timestamp,"deleted_at":nullable_timestamp,"published_at":nullable_timestamp,"expires_at":nullable_timestamp,
                "file_key":{"type":["string","null"]},"filename":{"type":["string","null"]},"content_type":{"type":["string","null"]},"size_bytes":{"type":["integer","null"],"minimum":0,"description":"File length in bytes"},"sha256":{"type":["string","null"]},
                "accounting":{"type":"string","enum":["none","reserved","published","cleanup","released"]},"retention_seconds":{"type":["integer","null"],"description":"Original creation lifetime in seconds; null means the resource was created without automatic expiration. Later deadline edits do not change this field. Read resource.expires_at for the current deadline."},"deleted_reason":{"type":["string","null"]},
                "accessible":{"type":"boolean"},"unavailable_reason":{"type":["string","null"],"enum":["pending","expired","deleted",null]},"share_url":{"type":"string"}
            }},
            "operation":{"type":"object","required":["operation_id","type","resource_id","status","steps","last_error","retry_count","total_attempts","next_retry_at","created_at","updated_at"],"properties":{
                "operation_id":{"type":"string"},"type":{"type":"string"},"resource_id":resource_id(),"status":{"type":"string","enum":["pending","running","retry_pending","completed","needs_attention"]},
                "steps":{"type":"object","required":["d1","kv","upload","r2_cleanup"],"properties":{
                    "d1":{"type":"string","enum":["completed"]},"kv":{"type":"string","enum":["pending","accepted","failed"]},"upload":{"type":"string","enum":["none","uploading","stored","failed","needs_reupload"]},"r2_cleanup":{"type":"string","enum":["none","pending","completed","failed"]}
                }},
                "last_error":{"oneOf":[error,{"type":"null"}]},"retry_count":{"type":"integer","minimum":0},"total_attempts":{"type":"integer","minimum":0},"next_retry_at":nullable_timestamp,"created_at":timestamp,"updated_at":timestamp
            }}
        }},
        {"type":"object","required":["error"],"properties":{"error":error}}
    ]})
}

pub fn resource_result_semantics() -> Value {
    json!({
        "authority":"Always query operation.get with the saved operation_id after transmission, including HTTP 2xx, HTTP errors or an interrupted response. HTTP status alone is not upload success; operation.get returns current authoritative resource and operation state.",
        "accessible":"resource.accessible determines current usability. true means published and neither deleted nor expired according to authoritative state; public KV/cache propagation can still lag.",
        "state":"resource.state describes persisted lifecycle (pending, published, deleted). A published resource can already be expired and inaccessible before cleanup. operation.status=completed alone does not mean the resource is accessible.",
        "share_url":"resource.share_url is the canonical public URL. Report it as usable only when accessible=true; the field also exists for pending, expired and deleted resources.",
        "expires_at":"Current absolute deadline in UTC Unix seconds, or null when no deadline is set. null on a pending upload does not mean the resource is available. retention_seconds is only the original creation policy: later edits can set a deadline on a resource created with null retention or remove the deadline from a finite-lifetime resource. Never infer the current deadline from retention_seconds or published_at; read expires_at and accessible. Legacy resources can lack published_at.",
        "operation":"steps.upload describes byte-transfer progress; steps.kv=accepted means KV accepted a write, not global propagation. last_error may retain an earlier failure after recovery; interpret current status and steps together.",
        "error":"An error envelope has code, step, retryable and message. retryable is advisory for that failure, not permission to upload again blindly. NOT_FOUND means no durable operation was observed at lookup time."
    })
}

pub fn upload_contract(origin: &str) -> Value {
    json!({
        "protocol_version":1,"url":format!("{origin}/upload"),"method":"POST","authorization":"Bearer <token>",
        "body":"multipart/form-data: metadata JSON first, then exactly one file part",
        "metadata_schema":upload_schema(),"generated_fields":["operation_id","size_bytes","sha256"],"max_metadata_bytes":MAX_METADATA_BYTES,
        "result_schema":operation_result_schema(),"result_semantics":resource_result_semantics(),
        "recovery":"Save operation_id, full metadata and exact local file bytes before upload. Always query operation.get after the HTTP attempt: HTTP status is not success and operation.get is authoritative. If NOT_FOUND, retain that ID and identical parameters for an explicit retransmission; do not mint a replacement ID. If steps.upload=needs_reupload and the resource is not deleted or expired, explicitly retransmit the identical parameters and bytes. For uploading/stored or other server-recoverable steps, poll operation.get or use operation.retry as appropriate; do not retransmit active uploads. Never replay deleted or expired resources as new uploads. Expired or rejected upload credentials require fresh authorization via MCP, not a new operation_id. The uploader does not automatically retransmit."
    })
}

pub fn oauth_upload_contract(origin: &str) -> Value {
    let mut contract = upload_contract(origin);
    contract["protocol_version"] = json!(2);
    contract["url"] = json!(format!("{origin}/mcp/upload"));
    contract["authorization"] = json!("Cf-Access-Token: <token>");
    contract
}
