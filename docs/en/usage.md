# Usage and MCP operations

[简体中文](../zh-CN/usage.md) · [Documentation](../../README.md#documentation)

## Connection and scope

Connect an MCP client supporting remote Streamable HTTP and OAuth to `https://<your-domain>/mcp`, complete browser login, then call `describe`. The service supports MCP `2025-11-25` and `2025-06-18`: supported requested versions are preserved; otherwise it returns its preferred version for the client to accept or reject. Verify login, refresh and revocation for each client against your deployment.

There is one administrator. Management and statistics require authentication; public links do not. There is no administration UI, multi-user collaboration, visitor password, visitor allowlist, custom alias, remote file import or recycle bin. File contents travel over HTTP; the server cannot read a client's local path.

## Discovery and invocation

MCP exposes only `describe` and `invoke`. The entries below are operation names, not additional MCP tools. Discover the current parameter Schema with `describe` before calling `invoke`; do not infer request shapes from static documentation.

| Operation | Purpose |
| --- | --- |
| `resource.create_url` | Create an HTTP/HTTPS short link |
| `resource.list` | Search and filter paginated resources |
| `resource.get` | Read details, share URL and current state |
| `resource.update` | Edit title, description, tags, URL target or expiration |
| `resource.delete` | Permanently mark a resource deleted and report KV/file cleanup |
| `session.create` | Create a 24-hour upload session |
| `session.list` | List sessions without credentials |
| `session.revoke` | Revoke an upload session |
| `operation.list` | Find ongoing operations or operations needing attention |
| `operation.get` | Read steps, results, errors and retry scheduling |
| `operation.retry` | Resume unfinished work the server can perform |
| `storage.get` | Read limits and published, reserved and cleanup bytes |
| `stats.query` | Summary, trends, referrers, regions and rankings |
| `stats.samples` | Query available platform visit samples |

Persist an operation ID and complete parameters before creation. Reusing the same ID and parameters returns the original resource; different parameters are rejected. If the result is unknown, query the original operation instead of creating another ID. HTTP success or a completed step does not establish accessibility; use `accessible`, `unavailable_reason` and individual step states.

## Sharing, editing and search

Every resource receives an independent 12-character random alphanumeric ID and a URL of the form `https://<domain>/r/<id>`. Files sharing a name or digest are not deduplicated. Old IDs are never reassigned.

Short links return 302 with `no-store`; editing a target preserves the share URL. Creation does not fetch the target page. Images display inline; other files download by default. Published file bytes, filenames, types, sizes and digests cannot be replaced: create a new resource for new content. Titles, descriptions and tags are management metadata. SVG is served unchanged without sanitization.

Resource lists default to 20 items, with a maximum of 100, ordered by descending creation time and a stable ID tiebreaker. Cursors bind filters but do not promise a database snapshot. Keywords match contiguous text in titles, descriptions and filenames; ASCII matching is case-insensitive and `%` / `_` are literal characters. Tags match exactly and all supplied tags must match; type, time and keyword filters are intersected.

## Expiration and deletion

Omitting `retention_seconds` on creation means 2592000 seconds (30 days) after first publication. A positive safe integer specifies a custom lifetime; explicit `null` means permanent. Waiting for upload or recovery does not consume a new resource's lifetime.

Before a published resource expires, set `expires_at` to an absolute future UTC Unix second, omit it to keep the deadline, or use `null` for permanent storage. Convert relative requests into an explicit saved deadline according to user intent; retries must not restart the clock. Ordinary edits and visits do not extend retention.

Expired resources cannot be renewed or restored. Default lists hide expired and deleted resources, but ID lookup retains their state; `state=published` can coexist with `accessible=false`.

Deletion commits logical state before KV propagation and R2 cleanup, reporting each step separately. KV acceptance does not mean every location has updated; old mappings can still be served during propagation, bounded by their original snapshot deadline of at most 24 hours. Expiration and deletion checks precede content-cache access, but cannot recall browser copies.

See [files and recovery](files.md) for uploads and [analytics](analytics.md) for counting rules.
