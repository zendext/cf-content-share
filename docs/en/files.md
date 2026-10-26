# Files, upload sessions and recovery

[简体中文](../zh-CN/files.md) · [Documentation](../../README.md#documentation)

File contents travel over HTTP. MCP exposes only `describe` and `invoke`; discover the current operation contract first.

## Upload protocol

1. Call authenticated MCP `describe` with `operation=session.create` to obtain the credential-free `upload` contract without creating a session. It contains `protocol_version=1`, URL/method, `generated_fields`, `max_metadata_bytes`, `metadata_schema`, `result_schema`, `result_semantics` and `recovery`. When authorization is needed, call `session.create` with an optional `client` label. It returns `session_id`, a token shown only once, creation time, a fixed 24-hour expiration and the complete same-origin upload contract.
2. Save the operation identifier, size and SHA-256 before `POST /upload`, using `Authorization: Bearer <token>`. One session can upload multiple files. Session lists are paginated and reveal neither plaintext tokens nor digests. Revocation and expiration prevent new uploads; already accepted uploads may finish.
3. Use `multipart/form-data` with exactly one JSON part named `metadata`, followed by one binary part named `file`. Metadata is bounded to 16 KiB, boundaries to 70 characters, and framing before and after the body has separate 256 KiB read budgets.
4. Required fields are `operation_id`, `filename`, `content_type`, `size_bytes` and `sha256`. Optional fields include `title`, `description`, `tags` and `retention_seconds`. Digests are 64 lowercase hexadecimal characters; size is an integer from 0 to 9007199254740991. MIME values have no parameters and filenames cannot contain control characters. The discovered Schema defines exact length and tag limits.
5. `201` means publication completed; `202` means a complete object still needs server finalization. A `409` operation result indicates ongoing work or a blocked concurrent retransmission; conflicting parameters return `IDEMPOTENCY_CONFLICT`. Validation/transport failures return `422` with durable operation and resource states. Authentication, metadata or capacity failures before acceptance create no background upload task. All responses disable caching.

D1 stores only token SHA-256 digests. Application tokens authorize only uploads; OAuth revocation does not revoke issued application tokens. Keep sessions and operation IDs scoped to the service origin in files readable only by the current user. Never log tokens.

After every HTTP attempt, call `operation.get` for the authoritative current result, including complete 2xx, non-2xx and unknown outcomes. HTTP status does not establish current accessibility. Replaying the same creation parameters returns the original resource even if published or deleted; changing parameters under the same ID is rejected. With `steps.upload=needs_reupload`, resend the complete file under the original operation ID and parameters. New operations create independent 12-character IDs even for identical filenames or digests. Deleted IDs and operation mappings remain reserved permanently.

## Generic local uploader

The [Skill](../../skills/cf-content-share/SKILL.md) guides contract discovery, user-intent mapping and result interpretation. [upload.py](../../skills/cf-content-share/scripts/upload.py) handles local files and HTTP only. It requires Python 3.12+ and only the standard library, without npm, pip or a virtual environment. Check interpreter capabilities as the Skill describes; do not assume Windows bundles Python. Repository `npm run check:upload` compiles Python and runs unittest; TypeScript platform tooling retains strict checking without emitted output.

`prepare --file --origin --metadata-file --contract-file --state-file` reads private JSON files. Metadata contains business parameters assembled from the current Schema; contract contains the discovered credential-free `upload` object. The script generates and protects `operation_id`, `size_bytes` and `sha256`, validates JSON/numeric safety, transport protocol and metadata byte limits, and saves v2 state once without overwriting. It has no built-in business field list, defaults or business-Schema interpreter. The server performs final business validation. Omitted fields, explicit `null`, arrays and nested objects are preserved.

`send --state-file --session-file` rechecks file size and digest, private permissions, session expiration, protocol and same-origin URLs, then streams one request. It never follows redirects, automatically retransmits on network failure, or prints response bodies or credentials.

The transport summary is `{operation_id, transport_status, http_status?, error_code?}`. Complete 2xx responses exit 0; complete non-2xx responses or local input errors exit 1; failed requests or incomplete responses exit 2. None of these exit codes establishes publication. Local errors may occur before a request and expose only sanitized diagnostics. After an actual HTTP attempt, the agent always queries `operation.get`, interpreting accessibility, the canonical URL and recovery using the discovered `result_schema`, `result_semantics` and `recovery`.

Never edit saved state metadata. Recovery preserves the original ID, parameters and file bytes. If the source or user requirements change, resolve the old operation before deciding to create another share. Update the Skill and helper together; compatible business-field changes are then carried by discovery without requiring local code updates.

## Validate uploads using the existing MCP login

`describe(operation=upload.authorization)` returns a credential-free protocol 2 upload contract. Invoking that operation returns the current verified Cloudflare Access JWT, its actual `expires_at`, and the same contract without creating a session. Save the contract and credential separately as private `contract.json` and `authorization.json`, use prepare as above, then run `send --state-file <private-state> --authorization-file <private-authorization.json>`. The script sends `Cf-Access-Token` only to the contract's same-origin `/mcp/upload` endpoint. It neither logs in nor refreshes OAuth and never reads the MCP client's private credentials.

The credential has MCP management authority. If it expires, obtain the current credential through authenticated MCP while preserving the operation ID, metadata and file, and still query `operation.get` before any retransmission. Do not mix protocol 1 and protocol 2 states and transport contracts or edit saved state. This path validates the real client handoff; it has not replaced existing upload sessions.

## Resource lifetime

Omitting `retention_seconds` means 2592000 seconds (30 days); a positive safe integer specifies a custom lifetime and explicit `null` means permanent. Publication time plus retention must remain a safe integer. D1 fixes `published_at` and `expires_at` at first successful publication. Waiting, retransmission and recovery neither consume a new resource's lifetime nor restart it.

Results expose `accessible`, `unavailable_reason`, `published_at` and `expires_at`; a `published` record may already be expired. Before expiration, `resource.update` can set a future absolute UTC Unix second in `expires_at`, use `null` for permanent storage, or omit it to preserve the deadline. Metadata edits do not change retention. Expired resources cannot be renewed, made permanent or republished, but remain queryable by ID. Default lists exclude them.

## Capacity and object writes

Optional `MAX_FILE_BYTES` and `TOTAL_STORAGE_BYTES` are decimal integer strings from 0 to 9007199254740991. Zero is an explicit zero limit; omission adds no corresponding product limit. Platform request/storage limits still apply. `storage.get` reports these settings and `published_bytes`, `reserved_bytes` and `cleanup_bytes`.

Conditional D1 writes register the resource, operation and reservation together; SQL triggers update counters in the same transaction. Total-limit checks include published, reserved and cleanup bytes. Publication moves reserved bytes to published; logical deletion of a published file moves them to cleanup. Deleting an unpublished file keeps its reservation. Release requires proof that the write cannot complete and cleanup is confirmed, or a durable overwrite fence. Failed R2 cleanup or exhausted retries never releases capacity.

Files use `objects/<resource_id>/<SHA-256(attempt_token)>`, with the current key persisted on the resource. Keys contain only the execution-token digest; management/upload results never expose execution tokens. Retransmissions preserve the resource ID and allocate a new attempt key. R2 metadata records operation ID and attempt token; writes use `etagDoesNotMatch: '*'` and native SHA-256 validation. Publication verifies ownership, actual size and native digest; an object with merely matching size and digest is insufficient.

Bytes flow through Rust/multer and `FixedLengthStream`. The reader yields for each network chunk rather than letting the parser absorb all ready chunks. The final chunk reaches R2 only after length and multipart termination checks; empty files validate all framing before R2 invocation. R2 may commit after receiving the declared length, so a later EOF error cannot be relied on to undo a write.

## Heartbeats, fences and concurrent deletion

Accepted uploads independently renew a 120-second lease every 30 seconds, including waits for file headers, stalled bodies and R2 writes. There is no additional total-upload deadline. Failed D1 renewal or lost ownership stops further byte submission and enters recovery; uninterrupted upload success is not guaranteed during D1 failure.

Lease expiration only permits recovery inspection, not immediate deletion or capacity release. A recoverer claims ownership through a conditional D1 update, then attempts a zero-byte create-only fence at the immutable attempt key with `role=fence` and matching operation/attempt ownership:

- Successful fence creation proves the old stream's create-only commit must fail. Its reservation can then be released and retransmission requested.
- An existing object is never overwritten. Verify ownership, size and SHA-256; publish a valid complete object or clean it up if the resource was deleted.
- Ownership or validation mismatch becomes `needs_attention`, retaining the reservation and leaving unknown objects untouched.
- Custom metadata distinguishes ordinary empty files from fences; fences are never published.

Fences remain permanently because an old writer can remain paused indefinitely. Removing a fence could let it consume already released space later. Its zero-byte body consumes no file-byte quota but still creates R2 object, metadata and operation overhead. There is no time-based fence garbage collection. New attempt keys allow retransmission without removing old fences.

Healthy heartbeats prevent Cron from taking over ordinary slow uploads. After heartbeat loss, fences provide durable proof that old writes cannot succeed. Stale recoverers touch only the old attempt key derived from their own snapshot; all D1 publication, release and confirmation operations verify the current execution token. New uploads cannot take over a valid recovery lease.

Deletion atomically records `deleted` and counter transitions before independently attempting a KV tombstone and R2 cleanup. One failed step does not block the other; each reports its own state. During an active upload, deletion propagates the tombstone and retains capacity; the upload operation later verifies and cleans up. Deletion cannot bypass proof of write termination. After successful R2 delete, a head query must confirm absence before capacity is released.

## Public reads

`GET/HEAD /r/<id>` validates KV state and falls back to D1 for missing, invalid or expired mappings. Pending mappings are not negative-cache entries that could block newly published files. If KV and D1 are both unavailable, return 503 rather than bypassing state checks for cached bytes. Snapshots explicitly contain `expires_at` (possibly `null`) and a version; invalid formats fall back to D1. Snapshots last at most 86400 seconds from `observed_at`, captured before the original D1 read; KV uses the same absolute `expiration`. Hits and late fills cannot extend it; skip fills with less than 60 seconds remaining. At a known resource deadline, consult D1 for renewal and return 404 when expiration is confirmed, without waiting for Cron.

Complete GETs can use Cache API, otherwise stream from R2. Only complete `200` responses are cached, with `public, max-age=86400` internally; browsers receive `private, max-age=31536000, immutable`. Cache hits copy mutable headers while keeping streamed bodies. Cache writes use `wait_until`; cache failures do not block an available R2 response. Deletion and expiration checks precede caching and apply to GET, HEAD, Range and before returning the response. Old snapshots after confirmed D1 deletion cannot outlive their original 24-hour deadline; D1 failure at that point returns 503. Local cache eviction is not global eviction, and existing browser copies cannot be recalled.

Single `bytes=start-end`, `bytes=start-` and `bytes=-suffix` ranges return 206 when satisfiable. Unsatisfiable or multiple ranges return uncached 416. Ranges read R2 directly and 206 responses are not cached. HEAD has no body and ignores Range. ETag negotiation is not implemented.

Recognized image MIME types are inline; other files are attachments. Filenames include a safe ASCII fallback and RFC 5987 UTF-8 parameter. SVG preserves its original bytes and `image/svg+xml`, without CSP or sanitization. Filename, type, size, digest and object key are immutable after publication. Title, description, tags and expiration remain editable before expiry; target URLs apply only to URL resources.

## Background recovery

The five-minute Cron scans up to 25 expired resources and then processes up to 25 registered recovery tasks. D1 rechecks expiration at deletion time to avoid deleting a resource renewed after scanning. Logical deletion and cleanup registration are atomic and follow the same fencing/capacity rules; one failure does not block other resources. Retry delays are 5, 10, 20 and 40 minutes, then hourly, with at most 10 automatic retries per round. Manual `operation.retry` resets the round count while retaining cumulative attempts and the latest error. Operations missing client bytes remain `needs_reupload` / `needs_attention`; completed cleanup does not mean successful publication.
