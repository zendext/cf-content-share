CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE uploads (
  operation_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL UNIQUE,
  metadata TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'stored', 'failed')),
  size_bytes INTEGER NOT NULL
);
