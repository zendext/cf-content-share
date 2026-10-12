use super::now;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use worker::{Env, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    Url,
    Image,
    File,
}

impl ResourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Url => "url",
            Self::Image => "image",
            Self::File => "file",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceState {
    Pending,
    Published,
    Deleted,
}

impl ResourceState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Published => "published",
            Self::Deleted => "deleted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Accounting {
    None,
    Reserved,
    Published,
    Cleanup,
    Released,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum OperationType {
    #[serde(rename = "resource.create_url")]
    CreateUrl,
    #[serde(rename = "resource.upload")]
    Upload,
    #[serde(rename = "resource.update")]
    Update,
    #[serde(rename = "resource.delete")]
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Pending,
    Running,
    RetryPending,
    Completed,
    NeedsAttention,
}

impl OperationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::RetryPending => "retry_pending",
            Self::Completed => "completed",
            Self::NeedsAttention => "needs_attention",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadState {
    None,
    Uploading,
    Stored,
    Failed,
    NeedsReupload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KvStatus {
    Pending,
    Accepted,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum R2Status {
    None,
    Pending,
    Completed,
    Failed,
}

#[derive(Deserialize, Serialize)]
pub struct Resource {
    pub id: String,
    pub kind: ResourceKind,
    pub state: ResourceState,
    pub target_url: Option<String>,
    pub title: String,
    pub description: String,
    pub tags: String,
    pub created_at: i64,
    pub deleted_at: Option<i64>,
    pub file_key: Option<String>,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub size_bytes: Option<u64>,
    pub sha256: Option<String>,
    pub accounting: Accounting,
    pub retention_seconds: Option<i64>,
    pub published_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub deleted_reason: Option<String>,
    pub expiration_policy_version: i64,
}
impl Resource {
    pub fn expired(&self) -> bool {
        self.expires_at.is_some_and(|time| time <= now())
    }
    pub fn unavailable_reason(&self) -> Option<&str> {
        if self.state == ResourceState::Deleted {
            Some(if self.deleted_reason.as_deref() == Some("expired") {
                "expired"
            } else {
                "deleted"
            })
        } else if self.expired() {
            Some("expired")
        } else if self.state != ResourceState::Published {
            Some("pending")
        } else {
            None
        }
    }
    pub fn output(&self, env: &Env) -> Result<Value> {
        let mut value = serde_json::to_value(self)?;
        let unavailable_reason = self.unavailable_reason();
        value["accessible"] = json!(unavailable_reason.is_none());
        value["unavailable_reason"] = json!(unavailable_reason);
        value
            .as_object_mut()
            .unwrap()
            .remove("expiration_policy_version");
        value["tags"] = serde_json::from_str(&self.tags)?;
        value["share_url"] = json!(format!("{}/r/{}", env.var("PUBLIC_ORIGIN")?, self.id));
        Ok(value)
    }
}
#[derive(Deserialize, Serialize)]
pub struct Operation {
    pub id: String,
    pub r#type: OperationType,
    pub resource_id: String,
    pub fingerprint: String,
    pub fingerprint_version: i64,
    pub status: OperationStatus,
    pub kv_status: KvStatus,
    pub error_code: Option<String>,
    pub retry_count: i64,
    pub total_attempts: i64,
    pub next_retry_at: Option<i64>,
    pub lease_token: Option<String>,
    pub lease_until: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub upload_state: UploadState,
    pub upload_token: Option<String>,
    pub r2_status: R2Status,
}
impl Operation {
    pub fn output(&self) -> Value {
        let last_error = self.error_code.as_ref().map(|code| {
            let step = match code.as_str() {
                "KV_SYNC_FAILED" => "kv_sync",
                "D1_PUBLISH_FAILED" => "d1_publish",
                "UPLOAD_ACTIVE" | "UPLOAD_STREAM_OR_CHECKSUM_FAILED" | "UPLOAD_REQUIRES_RETRANSMIT" => "upload",
                _ => "r2_cleanup",
            };
            let retryable = !matches!(code.as_str(),
                "OBJECT_OWNERSHIP_MISMATCH" | "UPLOAD_STREAM_OR_CHECKSUM_FAILED" | "UPLOAD_REQUIRES_RETRANSMIT"
            );
            json!({
                "code": code,
                "step": step,
                "retryable": retryable,
                "message": "任务保留了当前步骤与最近错误；上传正文缺失时由客户端沿用原参数重传，其他未完成步骤可通过 operation.retry 重新安排。"
            })
        });
        json!({
            "operation_id": self.id,
            "type": self.r#type,
            "resource_id": self.resource_id,
            "status": self.status,
            "steps": {
                "d1": "completed",
                "kv": self.kv_status,
                "upload": self.upload_state,
                "r2_cleanup": self.r2_status
            },
            "last_error": last_error,
            "retry_count": self.retry_count,
            "total_attempts": self.total_attempts,
            "next_retry_at": self.next_retry_at,
            "created_at": self.created_at,
            "updated_at": self.updated_at
        })
    }
}
