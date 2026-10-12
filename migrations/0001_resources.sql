CREATE TABLE resources (
    id TEXT PRIMARY KEY CHECK(length(id) = 12 AND id NOT GLOB '*[^A-Za-z0-9]*'),
    kind TEXT NOT NULL CHECK(kind = 'url'),
    state TEXT NOT NULL CHECK(state IN ('published', 'deleted')),
    target_url TEXT,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags)),
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    CHECK(state != 'published' OR target_url IS NOT NULL)
);
CREATE INDEX resources_created ON resources(created_at DESC, id DESC);

CREATE TABLE operations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('resource.create_url', 'resource.update', 'resource.delete')),
    resource_id TEXT NOT NULL REFERENCES resources(id),
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','retry_pending','completed','needs_attention')),
    kv_status TEXT NOT NULL DEFAULT 'pending' CHECK(kv_status IN ('pending','accepted','failed')),
    error_code TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 10),
    total_attempts INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER,
    lease_token TEXT,
    lease_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX operations_due ON operations(status, next_retry_at);
CREATE INDEX operations_created ON operations(created_at DESC, id DESC);
CREATE INDEX operations_resource ON operations(resource_id, created_at DESC, id DESC);
CREATE INDEX operations_latest ON operations(resource_id, sequence DESC);
