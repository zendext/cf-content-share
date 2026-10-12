// Expected wire shapes at test boundaries. Runtime assertions remain responsible
// for proving the Worker actually returns these values, including negative cases.
export type ApiError = {
  code: string;
  step: string;
  retryable: boolean;
  message: string;
};
export type Resource = {
  id: string;
  kind: string;
  state: string;
  title: string;
  description: string;
  tags: string[];
  target_url: string | null;
  share_url: string;
  created_at: number;
  deleted_at: number | null;
  filename: string | null;
  file_key: string | null;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  accounting: string;
  retention_seconds: number | null;
  published_at: number | null;
  expires_at: number | null;
  deleted_reason: string | null;
  accessible: boolean;
  unavailable_reason: string | null;
};
export type Operation = {
  operation_id: string;
  resource_id: string;
  type: string;
  status: string;
  steps: { d1: string; kv: string; upload: string; r2_cleanup: string };
  last_error: ApiError | null;
  retry_count: number;
  total_attempts: number;
  next_retry_at: number | null;
  created_at: number;
  updated_at: number;
};
export type ResourceResult = { resource: Resource; operation: Operation };
export type Page<T> = {
  items: T[];
  has_more: boolean;
  next_cursor: string | null;
};
export type Session = {
  session_id: string;
  token: string;
  created_at: number;
  expires_at: number;
  upload: UploadContract;
};
export type ListedSession = {
  id: string;
  created_at: number;
  expires_at: number;
  revoked: number;
  client: string | null;
};
export type Schema = {
  [key: string]: unknown;
  type?: string | string[];
  properties: Record<string, Schema>;
  required?: string[];
  examples: Record<string, unknown>[];
  additionalProperties?: boolean;
  description?: string;
  default?: unknown;
  enum?: unknown[];
};
export type UploadContract = {
  url: string;
  method: string;
  protocol_version: number;
  authorization: string;
  generated_fields: string[];
  max_metadata_bytes: number;
  metadata_schema: Schema;
  result_schema: Schema;
  result_semantics: Record<string, string>;
  recovery: string;
};
export type Descriptor = {
  token?: never;
  session_id?: never;
  name: string;
  inputSchema: Schema;
  resultSchema: Schema;
  result_semantics: Record<string, string>;
  result: string;
  side_effects: string;
  example: Record<string, unknown>;
  upload: UploadContract;
};
export type Catalog = {
  operations: { name: string }[];
  defaults: { mapping_freshness_seconds: number };
};
export type Storage = {
  published_bytes: number;
  reserved_bytes: number;
  cleanup_bytes: number;
  max_file_bytes: number | null;
  total_storage_bytes: number | null;
};
export type StatsRow = {
  visits: number;
  bucket_start?: number;
  referer?: string | null;
  city?: string | null;
  country?: string | null;
  region?: string | null;
  resource_id?: string;
  kind?: string;
  resource?: Partial<Resource>;
  _sample_interval?: number;
  event_id?: string;
  time?: number;
  status?: number;
};
export type StatsResult = Page<StatsRow> & {
  timezone: string;
  completeness: string;
  diagnostics: string[];
};
export type Results = {
  'resource.create_url': ResourceResult;
  'resource.get': ResourceResult;
  'resource.update': ResourceResult;
  'resource.delete': ResourceResult;
  'operation.get': ResourceResult;
  'operation.retry': ResourceResult;
  'resource.list': Page<Resource>;
  'operation.list': Page<Operation>;
  'session.create': Session;
  'session.list': Page<ListedSession>;
  'session.revoke': ListedSession;
  'storage.get': Storage;
  'stats.query': StatsResult;
  'stats.samples': StatsResult;
};
export type Mapping = {
  id: string;
  state: string;
  observed_at: number;
  valid_until: number;
  [key: string]: unknown;
};
export type D1Event = { sql: string; bindings: unknown[] };
export type R2Event = {
  key: string;
  options: { customMetadata: Record<string, string> };
  memory: number;
  stored: boolean;
};
export type CacheEvent = {
  url: string;
  status?: number;
  cacheControl?: string | null;
};
export type Heartbeat = { tick: boolean; offset?: number };
export type AnalyticsPoint = {
  indexes: string[];
  blobs: string[];
  doubles: number[];
};
