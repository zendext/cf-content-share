# Architecture and consistency

[简体中文](../zh-CN/architecture.md) · [Documentation](../../README.md#documentation)

## Components and trust boundaries

One Rust/Wasm Worker handles these endpoints and a five-minute Cron:

| Entry | Authentication and responsibility |
| --- | --- |
| `/mcp` | Access Managed OAuth; the Worker validates Access JWTs and handles `describe` / `invoke` |
| `POST /mcp/upload` | Validation path for shared authorization; the same Access application and JWT checks |
| `POST /upload` | The Worker validates an application Bearer token and streams to R2 |
| `GET/HEAD /r/<id>` | Public access; check resource state before redirecting or serving bytes |
| scheduled | Recover registered operations and clean up expired resources and files |

Access protects only `/mcp`, not the entire domain. JWT checks cover signatures, issuer, audience and time. Upload tokens authorize only uploads, last 24 hours and are stored only as digests in D1. OAuth revocation does not automatically revoke issued upload sessions.

`/mcp/upload` is under the existing Access path. `upload.authorization` returns the current MCP request's verified Cloudflare Access JWT and its actual `exp`, without issuing a token or creating a D1 session. The script sends it as `Cf-Access-Token`; Access forwards an assertion to the Worker, which repeats the same JWT checks. This credential has MCP management authority, not just upload authority. It is not an OAuth refresh token; use the returned expiration rather than assuming it matches the OAuth access token lifetime. Keep `/upload` and its sessions until the real client handoff is verified. Local tests that simulate Access headers do not establish live compatibility.

## Sources of state

D1 is authoritative for resources, sessions, operations, execution leases and capacity counters. KV is a derived public mapping; R2 stores private contents. Analytics Engine stores visit events separately. There is no cross-service transaction across D1, KV and R2.

[`src/store/`](../../src/store/) centralizes D1 SQL and typed data access; business modules validate inputs, coordinate state transitions and call external services. SQL migrations define persistent Schema; MCP `describe` exposes request and result contracts.

Resources use `pending`, `published` and `deleted` states. Operations retain step states, cumulative attempts, the latest error and retry scheduling. Logical deletion, KV acceptance and completed R2 cleanup are separate facts. Creation and upload persist operation IDs, parameter fingerprints and resource mappings, so retries return the same resource's current state. Deleted IDs and operation mappings are retained to prevent reuse or revival.

## Files and capacity

Uploads first atomically register a resource, operation and reservation in D1, then stream to R2 under an immutable attempt key. Publication requires verified ownership, size and native SHA-256. Total usage is `published_bytes + reserved_bytes + cleanup_bytes`; conditional writes and SQL triggers account for each transition once.

Each attempt has its own key and execution token. A heartbeat every 30 seconds maintains a 120-second lease. Expiration permits recovery inspection, not immediate capacity release. Recovery uses a create-only, zero-byte fence to prevent a late old write, or verifies an already completed object. Fences remain permanently. Unknown objects require attention and are not deleted automatically. See [files and recovery](files.md).

## KV, expiration and caches

Public reads check mapping state and deadlines before reading content, falling back to D1 for missing or invalid snapshots. A snapshot remains valid for at most 86400 seconds from `observed_at`, recorded before the original D1 read. KV uses the same absolute expiration; hits and delayed fills never extend it. Fills with less than 60 seconds left are skipped. When both KV and D1 are unavailable, return 503 instead of bypassing state checks to serve cached bytes.

At a known deadline, consult D1 for a possible extension; confirmed expiration returns 404 without waiting for Cron. Deletion and target changes are subject to KV propagation. Cache API stores only complete 200 responses for 86400 seconds; browsers receive `private, max-age=31536000, immutable`. Deleting a cache entry in one location does not clear every location, and browser copies cannot be recalled. Short links use `302` and `no-store`.

Resources receive their deadline at first publication. Ordinary edits, visits and retries do not restart retention.

## Recovery and analytics

Each Cron run scans at most 25 expired resources and processes at most 25 recovery tasks. Deletion conditions are rechecked at the D1 write; state changes and cleanup tasks are registered together. Retry delays are 5, 10, 20 and 40 minutes, then hourly, with at most 10 automatic retries per round. Manual retry preserves cumulative attempts and errors. Cron cannot resend file bytes held only by a client.

The public response boundary records successful GET 302, 200 and 206 responses once each. HEAD and errors do not count; ranges, bots and previews do. Statistics use `_sample_interval` weights and do not promise a complete access log. Collection failure does not change the public response; query failure never becomes a fabricated zero. See [analytics](analytics.md).

## Verification boundaries

`npm run check` covers formatting, types, build and local workerd regressions, including fault injection. Fault controls exist only in test fixtures. Local tests and dry-runs do not establish real Access client compatibility, cross-location KV propagation, cloud concurrency recovery or long-lived browser-cache behavior; those need targeted post-deployment verification.
