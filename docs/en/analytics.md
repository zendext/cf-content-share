# Analytics

[简体中文](../zh-CN/analytics.md) · [Documentation](../../README.md#documentation)

Call `stats.query` and `stats.samples` through MCP `describe` / `invoke`. Events go only to Analytics Engine; D1 retains resource titles and deletion state, not visit events. Discover exact parameter Schemas through `describe({operation: ...})`.

## Collection and configuration

The public response boundary calls `stats::collect` once for each GET 302, 200 or 206. HEAD, 304 and errors do not count. Retries, ranges, bots, previews, cache hits and responses still served during deletion propagation follow the same rule. Collection uses the resource kind actually served, without rereading D1. A successful server response does not prove that the client downloaded the complete file.

| Setting | Type | Purpose |
| --- | --- | --- |
| `ANALYTICS` | Analytics Engine binding | Write events |
| `ANALYTICS_DATASET` | var | Same name as the binding dataset; `[A-Za-z_][A-Za-z0-9_]{0,127}` |
| `CLOUDFLARE_ACCOUNT_ID` | var | 32-character hexadecimal account ID |
| `ANALYTICS_API_TOKEN` | Worker Secret | Account Analytics Read permission for this account |
| `DEFAULT_TIMEZONE` | var | Defaults to `Asia/Shanghai`; queries can override it |

The query token is used only against the fixed Cloudflare SQL endpoint, never in discovery, results or logs. SQL HTTP redirects are rejected. Missing query configuration returns `ANALYTICS_NOT_CONFIGURED`.

[stats.rs](../../src/stats.rs) defines event fields:

| Field | Contents |
| --- | --- |
| `index1` | Resource ID, used as the platform sampling index |
| `blob1` | Random 12-character alphanumeric event ID |
| `blob2` / `blob3` | Resource ID / served kind: `url`, `image`, `file` |
| `blob4` | Original request Referer |
| `blob5` / `blob6` / `blob7` | Cloudflare country / region / city |
| `double1` / `double2` | UTC Unix seconds / HTTP status |

Missing referrer or geographic fields are stored as empty strings and returned as `null` (unknown), without inferred geographic detail. Total UTF-8 blob size is limited to 16 KiB and index size to 96 bytes. Oversized events are not truncated: log `ANALYTICS_EVENT_TOO_LARGE` and skip collection. Native write failures log `ANALYTICS_COLLECTION_FAILED`. Logs omit Referer, tokens and raw exceptions; collection failure leaves the public response unchanged. Workers sends data in the background after synchronous native submission, which does not prove final platform receipt or completeness.

## Query contract

Both operations require explicit UTC Unix integer seconds `start` and `end` for `[start,end)`, within the last 30 days at call time, with `start < end <= now`. Invalid windows return `INVALID_TIME_RANGE` rather than being clipped. Optional filters include `resource_id`, `kind` and `timezone`. Timezones are validated against the Worker's `Intl.DateTimeFormat` IANA database; fixed offsets are not accepted and unsupported zones return `INVALID_TIMEZONE`.

`stats.query` requires `view`:

| view | Main item fields | Additional parameters |
| --- | --- | --- |
| `summary` | `visits` | No limit or granularity |
| `trend` | `bucket_start`, `visits` | `granularity`: `hour` or default `day`; no limit |
| `referrers` | `referer`, `visits` | limit defaults to 20, maximum 100 |
| `regions` | `country`, `region`, `city`, `visits` | limit defaults to 20, maximum 100 |
| `top` | `resource_id`, `kind`, `visits`, `resource` | limit defaults to 20, maximum 100 |

Visits use `SUM(_sample_interval)`, never row counts. Referrers group by the original Referer. Trends use Analytics Engine `toStartOfInterval(toDateTime(double1), INTERVAL '1' HOUR|DAY, timezone)`, returning UTC Unix seconds for `bucket_start`; repeated autumn hours have different UTC starts. Only observed buckets are returned, without filling unknown buckets with zero. A maximum of 750 buckets covers 30 days at hour/day granularity. Summary totals are independent of list/ranking limits.

`stats.samples` also supports exact `referer`, `country`, `region` and `city` filters; empty strings select missing fields. SQL compares `hex(column) = 'UTF8HEX'` rather than inserting raw text literals. It defaults to 20 items, maximum 100, retaining event ID, resource ID, kind, UTC time, status, original source/region and `_sample_interval`. Ordering is descending time, then descending event ID. `next_cursor` binds all filters, effective timezone, window and order; page size can change. Mismatched conditions return `INVALID_CURSOR`.

Both operations return effective `start` / `end` / `timezone` / `granularity`, `sampling`, `completeness: "unknown"` and supported `diagnostics`. Sample `has_more` only indicates that this query observed another page; it does not establish a complete access log, fixed pagination snapshot or fixed error rate. Sampling and arrival delays can change subsequent pages.

One D1 query enriches ranking/sample resources, and the top-level resource for an explicit resource filter, with `id`, `title`, `state`, `expires_at`, `published_at`, `deleted_reason`, `accessible` and `unavailable_reason`, including deleted and expired resources. A resource awaiting expiration cleanup may be `state=published`, `accessible=false`, `unavailable_reason=expired`. Missing metadata produces `state=unknown`; D1 failure adds `RESOURCE_METADATA_UNAVAILABLE` without changing weighted counts. Changing a URL target does not reset or split resource statistics.

HTTP/network failures return `ANALYTICS_QUERY_FAILED`; malformed JSON or result shapes return `ANALYTICS_RESPONSE_INVALID`, never fabricated zero visits. Platform error objects inside HTTP 200 are also sanitized. Responses are bounded to 12 MiB, sufficient for up to 101 samples with 16 KiB blobs and worst-case sixfold JSON escaping; exceeding the limit fails explicitly.

## Implementation and verification boundaries

Analytics Engine queries order by SELECT output aliases; WHERE and GROUP BY use original column names. Preserve this platform compatibility requirement when changing queries. File responses do not generate ETags or conditional 304 responses; requests with If-None-Match or If-Modified-Since still return 200 and count.

`npm test` uses local workerd and SQL boundary substitutes to verify collection, weights, timezones, cursors and errors. In a private environment with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, run `node tests/stats-cloud-probe.mts` for read-only synthetic SQL function checks. Neither proves final production event-delivery completeness; verify the real dataset and client after deployment.
