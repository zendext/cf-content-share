-- Preserve deployed URL resources and operation identities while extending checks.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE resources_new (
 id TEXT PRIMARY KEY CHECK(length(id)=12 AND id NOT GLOB '*[^A-Za-z0-9]*'),
 kind TEXT NOT NULL CHECK(kind IN ('url','image','file')),
 state TEXT NOT NULL CHECK(state IN ('pending','published','deleted')),
 target_url TEXT, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
 tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags)), created_at INTEGER NOT NULL, deleted_at INTEGER,
 file_key TEXT, filename TEXT, content_type TEXT, size_bytes INTEGER CHECK(size_bytes>=0), sha256 TEXT,
 accounting TEXT NOT NULL DEFAULT 'none' CHECK(accounting IN ('none','reserved','published','cleanup','released')),
 CHECK(state!='published' OR (kind='url' AND target_url IS NOT NULL) OR (kind!='url' AND file_key IS NOT NULL AND filename IS NOT NULL AND size_bytes IS NOT NULL AND sha256 IS NOT NULL))
);
INSERT INTO resources_new(id,kind,state,target_url,title,description,tags,created_at,deleted_at) SELECT id,kind,state,target_url,title,description,tags,created_at,deleted_at FROM resources;
CREATE TABLE operations_new (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 type TEXT NOT NULL CHECK(type IN ('resource.create_url','resource.upload','resource.update','resource.delete')),
 resource_id TEXT NOT NULL REFERENCES resources_new(id), fingerprint TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','retry_pending','completed','needs_attention')),
 kv_status TEXT NOT NULL DEFAULT 'pending' CHECK(kv_status IN ('pending','accepted','failed')),
 error_code TEXT, retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 10),
 total_attempts INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER, lease_token TEXT, lease_until INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 upload_state TEXT NOT NULL DEFAULT 'none' CHECK(upload_state IN ('none','uploading','stored','failed','needs_reupload')),
 upload_token TEXT, r2_status TEXT NOT NULL DEFAULT 'none' CHECK(r2_status IN ('none','pending','completed','failed'))
);
INSERT INTO operations_new(sequence,id,type,resource_id,fingerprint,status,kv_status,error_code,retry_count,total_attempts,next_retry_at,lease_token,lease_until,created_at,updated_at) SELECT sequence,id,type,resource_id,fingerprint,status,kv_status,error_code,retry_count,total_attempts,next_retry_at,lease_token,lease_until,created_at,updated_at FROM operations;
DROP TABLE operations;
DROP TABLE resources;
ALTER TABLE resources_new RENAME TO resources;
ALTER TABLE operations_new RENAME TO operations;
CREATE INDEX resources_created ON resources(created_at DESC,id DESC);
CREATE INDEX operations_due ON operations(status,next_retry_at);
CREATE INDEX operations_created ON operations(created_at DESC,id DESC);
CREATE INDEX operations_resource ON operations(resource_id,created_at DESC,id DESC);
CREATE INDEX operations_latest ON operations(resource_id,sequence DESC);
CREATE TABLE upload_sessions(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),client TEXT);
CREATE INDEX sessions_created ON upload_sessions(created_at DESC,id DESC);
CREATE TABLE storage_usage(id INTEGER PRIMARY KEY CHECK(id=1),published_bytes INTEGER NOT NULL DEFAULT 0 CHECK(published_bytes>=0),reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),cleanup_bytes INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_bytes>=0));
INSERT INTO storage_usage(id) VALUES(1);
CREATE TRIGGER storage_insert AFTER INSERT ON resources WHEN NEW.kind!='url' BEGIN
 UPDATE storage_usage SET published_bytes=published_bytes+CASE WHEN NEW.accounting='published' THEN NEW.size_bytes ELSE 0 END,reserved_bytes=reserved_bytes+CASE WHEN NEW.accounting='reserved' THEN NEW.size_bytes ELSE 0 END,cleanup_bytes=cleanup_bytes+CASE WHEN NEW.accounting='cleanup' THEN NEW.size_bytes ELSE 0 END WHERE id=1;
END;
CREATE TRIGGER storage_transition AFTER UPDATE OF accounting ON resources WHEN NEW.accounting!=OLD.accounting BEGIN
 UPDATE storage_usage SET published_bytes=published_bytes+CASE WHEN NEW.accounting='published' THEN NEW.size_bytes ELSE 0 END-CASE WHEN OLD.accounting='published' THEN OLD.size_bytes ELSE 0 END,reserved_bytes=reserved_bytes+CASE WHEN NEW.accounting='reserved' THEN NEW.size_bytes ELSE 0 END-CASE WHEN OLD.accounting='reserved' THEN OLD.size_bytes ELSE 0 END,cleanup_bytes=cleanup_bytes+CASE WHEN NEW.accounting='cleanup' THEN NEW.size_bytes ELSE 0 END-CASE WHEN OLD.accounting='cleanup' THEN OLD.size_bytes ELSE 0 END WHERE id=1;
END;
