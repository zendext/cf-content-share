# Deployment and upgrades

[简体中文](../zh-CN/deployment.md) · [Documentation](../../README.md#documentation)

## Tools and identity

Run commands from the repository root. You need Node.js 24.12+, rustup, a Cloudflare-managed domain, and access to Workers, D1, KV, R2, Analytics Engine and Zero Trust. `rust-toolchain.toml` pins Rust and its components.

```sh
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$PWD/target"
rustup show
cargo install worker-build --version 0.8.7 --locked
npm ci
umask 077
cp deployment.example.json deployment.local.json
chmod 600 deployment.local.json
```

Create a Custom Token in [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens), restricting account resources to the target account and Zone resources to the target Zone:

| Scope | Permission | Level |
| --- | --- | --- |
| Account | Workers Scripts | Edit |
| Account | D1 | Edit |
| Account | Workers KV Storage | Edit |
| Account | Workers R2 Storage | Edit |
| Account | Account Analytics | Read |
| Account | Access: Apps and Policies | Edit |
| Account | Access: Organizations, Identity Providers, and Groups | Edit |
| Zone | Workers Routes | Edit |
| Zone | Zone | Read |
| Zone | DNS | Edit |

DNS and the two Access write permissions support agent configuration; omit them when configuring those services manually. Prefer a separate token with only Account Analytics Read for the target account. Reusing the deployment token gives the runtime Secret deployment write permissions too. Do not restrict the analytics token to only your workstation's egress IP. R2 S3 credentials cannot replace a Cloudflare API token.

Keep the token in a regular file outside the repository with permissions `0600`, passed to scripts using `--token-file /private/cloudflare-api-token`, or use `CLOUDFLARE_API_TOKEN`. Never expose it in command arguments, chat, logs or Git. `--token-file` does not log Wrangler in; Wrangler needs the token in its child-process environment or its own login.

## Access, DNS and configuration

Inspect the existing Zone, DNS, Workers, Access organization, IdP, applications and resources first. Reuse exact matches; a 403 does not mean absence. Stop and explain conflicts with other services or overlapping policies.

1. Reuse the existing Zero Trust team without renaming or recreating it. If absent, create the team name supplied by the user.
2. Reuse or add a Cloudflare IdP with **Restrict to account members** enabled. The allowed email must belong to the account; do not broaden policy automatically.
3. Create a Self-hosted Access application protecting only the sharing host's `mcp` path. Use one Allow policy with **Emails** specifying the administrator's full email and only the IdP above. Ensure parent applications do not intercept `/r/*`, `/upload` or OAuth discovery. Do not substitute Everyone, broad email domains or Bypass for personal authentication.
4. Enable **Managed OAuth**, allowing localhost, loopback or explicit HTTPS redirect URIs as required by the actual clients. Configure access-token and grant-session lifetimes explicitly and verify refresh behavior. Copy the team issuer and Application Audience (AUD).
5. Use proxied DNS and a `<host>/*` Worker Route. A dedicated subdomain without an origin can use an AAAA `100::` placeholder. Do not overwrite conflicting targets, Routes or Custom Domains. Configure DNS and Access separately through the dashboard or API; the initialization script does not manage them.

References: [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/), [IdP](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/), [Access paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), [Worker Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/).

Fill `deployment.local.json`, replacing every zero or example placeholder:

| Field | Contract |
| --- | --- |
| `account_id` | 32 lowercase hexadecimal characters |
| `worker_name` / `resource_prefix` | Worker name and resource prefix |
| `d1_name` / `kv_name` / `r2_name` | Optional exact names; 3–63 lowercase letters, digits or hyphens, starting/ending with a letter or digit |
| `analytics_dataset` | Optional; starts with a letter, followed by letters, digits or underscores, maximum 64 characters |
| `public_origin` / `zone_name` | `https://share.example.com` / `example.com`; no path, port or trailing slash in the origin |
| `access_issuer` / `access_aud` | `https://<team>.cloudflareaccess.com` / 64-character application audience |
| `default_timezone` | Defaults to `Asia/Shanghai`; use an IANA timezone name |
| `max_file_bytes` / `total_storage_bytes` | Optional nonnegative decimal integer strings up to `9007199254740991`; `"0"` is an explicit zero limit, omission adds no product limit |

D1 and R2 default to the prefix; KV uses `<prefix>-mappings`; analytics replaces prefix hyphens with underscores. The input and generated `wrangler.cloud.json` are ignored by Git; add custom paths to local ignore rules yourself. Configuration contains no tokens, emails or OAuth client credentials.

## Initialize resources

```sh
npm run init:cloud -- --config deployment.local.json --token-file /private/cloudflare-api-token
npm run init:cloud -- --config deployment.local.json --token-file /private/cloudflare-api-token --apply
```

The first command uses only GET and writes no files. The second creates missing D1/KV/R2 resources and atomically writes a `0600` configuration. `--output` can target an existing parent directory; entry and migration paths are relative to that output, while builds run from the repository root. The script does not migrate, deploy, set Secrets, configure Access/DNS or create a live Route. Deployment applies the generated Route configuration.

The script reads complete pagination and matches exact names. New buckets use Standard storage; existing buckets must explicitly be Standard, with both `r2.dev` and custom-domain access disabled. Unknown storage/public state, duplicate names or mismatched old bindings stop execution without repairing existing resources. Unknown custom output settings also prevent overwriting. Change ordinary settings in the input file; never delete output merely to bypass conflicts.

Failures can leave already created resources. Rerun the read-only plan, then `--apply` to reuse them. The script does not blindly retry creation or delete existing data. A `.lock` beside the output guards concurrency; remove a stale lock only after confirming the process has exited. Do not initialize the same resource set in parallel.

Generated configuration includes DB, MAPPINGS, FILES, ANALYTICS and required variables, a five-minute Cron, and disabled workers.dev/preview URLs. Analytics Engine creates the dataset after its first event; initialization alone produces no analytics data.

## First deployment

Verify configuration, bindings and domain before execution. Enter these commands step by step in Bash / Zsh without `set -x`; pasting the token at `read` keeps it out of command history. An existing installation with data and no expiration support must use the maintenance procedure below instead.

```sh
read -r -s CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN
npm run check
npx wrangler deploy --dry-run --config wrangler.cloud.json
npx wrangler d1 migrations list DB --remote --config wrangler.cloud.json
npx wrangler d1 migrations apply DB --remote --config wrangler.cloud.json
npx wrangler secret put ANALYTICS_API_TOKEN --config wrangler.cloud.json < /private/analytics-api-token
npx wrangler deploy --config wrangler.cloud.json
node scripts/activate-expiration.mts --config wrangler.cloud.json
node scripts/activate-expiration.mts --config wrangler.cloud.json --apply
unset CLOUDFLARE_API_TOKEN
```

When explicitly choosing one token, replace the Secret command with `printf '%s' "$CLOUDFLARE_API_TOKEN" | npx wrangler secret put ANALYTICS_API_TOKEN --config wrangler.cloud.json`. Agents reading private token files must pass credentials only through child-process environments and stdin, without printing them.

Migrations run in 0001, 0002, 0003 order and are deduplicated by Wrangler records. Never rewrite applied migrations. Migration 0003 prepares columns, indexes, triggers and legacy deletion reasons without starting old-resource countdowns. Activate only after deploying a compatible Worker. Even an empty installation should record its unique T0 before accepting business traffic. If the first Secret write needs a placeholder Worker, verify its name.

Read back the Worker version, bindings, Route, Secret names and Cron. Connect MCP and complete real browser OAuth, then follow [deployment verification](#verify-the-deployment) and install the [sharing Skill](../../skills/cf-content-share/SKILL.md). Plans and dry-runs do not prove deployment or end-to-end success.

## Routine upgrades

Check the final code with `npm run check` and a dry-run using production configuration. Inspect migration lists, bindings, Route, Secret names, Cron, capacity and existing resources. Evaluate compatibility and back up before any required migration. With no new migration, deploy only the Worker; do not reinitialize resources or reset T0. Update the Skill and helper together. Keep version and verification records in a private directory outside the repository.

## Enabling expiration on an older installation

Use a short maintenance window when upgrading existing data from a version without expiration. Private directories use `0700` and backup files `0600`; create the external private `release_dir` used below beforehand.

### 1. Maintenance and frozen build

After checks, freeze the final `build/index.js` and `build/index_bg.wasm`. Prepare three private Wrangler configurations with identical name/account/Route/bindings/vars/Cron and different entries only. Resolve main and migrations_dir to absolute paths and remove the build command to prevent rebuilding between stages:

- `wrangler.production.json` points to the final build.
- `wrangler.maintenance-only.json` points to a static maintenance entry.
- `wrangler.compatible-maintenance.json` loads the final build but disables business handlers.

Static maintenance entry:

```ts
export default {
  fetch(request: Request) {
    return new Response(request.method === 'HEAD' ? null : 'Service temporarily unavailable.\n', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '60' },
    });
  },
  scheduled() {},
};
```

Compatible maintenance entry (replace the build path):

```ts
import Worker from '/absolute/path/to/cf-content-share/build/index.js';
export * from '/absolute/path/to/cf-content-share/build/index.js';
export default class extends Worker {
  fetch(request: Request) {
    return new Response(request.method === 'HEAD' ? null : 'Service temporarily unavailable.\n', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '60' },
    });
  }
  scheduled() {}
}
```

First verify GET/HEAD/POST, headers and scheduled handlers for both entries in local workerd, without business storage or external requests. Keep Access unchanged: unauthenticated requests may receive 401 first. Do not add an authentication bypass.

```sh
umask 077
release_dir=/private/cf-content-share-release
sha256sum build/index.js build/index_bg.wasm > "$release_dir/bundle.sha256"
npx wrangler deploy --dry-run --config "$release_dir/wrangler.maintenance-only.json"
npx wrangler deploy --dry-run --config "$release_dir/wrangler.compatible-maintenance.json"
npx wrangler deploy --dry-run --config "$release_dir/wrangler.production.json"
npx wrangler deploy --config "$release_dir/wrangler.maintenance-only.json"
```

Confirm the maintenance version receives 100% of traffic and returns 503. Deployment does not terminate old requests: wait for in-flight uploads/recovery to drain and inspect active leases, operations and capacity. Closing MCP clients alone does not stop uploads; removing Cron configuration does not establish immediate deactivation. Maintenance scheduled handlers must do no business work.

### 2. Backups and Schema

Record original resource states, counts, capacity, R2 object inventory and digests before backing up D1, migration records and recovery bookmarks. D1 export may block queries, so perform it during maintenance.

```sh
npx wrangler deployments list --config "$release_dir/wrangler.production.json"
npx wrangler d1 migrations list DB --remote --config "$release_dir/wrangler.production.json"
npx wrangler d1 time-travel info DB --config "$release_dir/wrangler.production.json"
npx wrangler d1 export DB --remote --config "$release_dir/wrangler.production.json" --output "$release_dir/backup-before-upgrade.sql"
sha256sum "$release_dir/backup-before-upgrade.sql" > "$release_dir/backup-before-upgrade.sha256"
npx wrangler d1 migrations apply DB --remote --config "$release_dir/wrangler.production.json"
node scripts/activate-expiration.mts --config "$release_dir/wrangler.production.json"
```

The first preview should report `activated=false`. If already activated, verify the original T0 instead of deleting it to restart the clock. D1 backups do not include R2 bytes; restoring files requires separate object backups.

### 3. Compatible deployment and activation

```sh
sha256sum -c "$release_dir/bundle.sha256"
npx wrangler deploy --config "$release_dir/wrangler.compatible-maintenance.json"
```

Confirm the new version and maintenance state before activation:

```sh
node scripts/activate-expiration.mts --config "$release_dir/wrangler.production.json" --apply
node scripts/activate-expiration.mts --config "$release_dir/wrangler.production.json"
sha256sum -c "$release_dir/bundle.sha256"
npx wrangler deploy --config "$release_dir/wrangler.production.json"
```

The activation script requires `--config` and supports `--env NAME` and `--token-file`. Without `--apply` it is read-only. One `INSERT OR IGNORE` lets D1 generate T0; its trigger records the migration count and assigns `T0 + 2592000` to old nondeleted resources, including pending ones, in the same statement. Late legacy inserts use the same T0; publication of old pending resources preserves their deadline.

Save `activated_at`, `legacy_expires_at` and `migrated_count`, and reconcile resources. After a lost response, query read-only first. Reapplication preserves T0 and subsequent edits. The count describes activation-time migration only; inspect late inserts separately. Never bulk UPDATE deadlines to restart retention or overwrite permanent settings. After restoring the public entry, verify old links, object digests, default/custom/permanent resources, renewal and natural expiration cleanup.

### 4. Failure recovery

If restoration fails, stay in compatible maintenance, repair and deploy the same verified build. After activation, never roll back to a Worker that ignores expiration. Compatible rollback must preserve deadlines, KV snapshot expiration and deletion rules. Code rollback does not restore D1/KV/R2; readable Schema alone does not establish compatibility.

Keep writes stopped during data restoration. Rehearse with a separate database and configuration, checking IDs, object keys, migrations, original T0 and digests. Do not import a complete SQL dump into a nonempty production database or recreate the database to undo migration. Restoration must not restart the 30-day clock. Time Travel affects the entire database and does not back up R2; deleted bytes cannot be restored without an object copy.

## Verify the deployment

Verify real MCP calls, administrator login and rejection of other identities, OAuth refresh/revocation, anonymous sharing, rejection of invalid upload tokens, download digests, deletion/recovery, event statistics and timezones, and actual Cron execution. Activation also requires unchanged original T0, deadline rejection for short-lived GET/HEAD/Range requests and file cleanup. Delete test resources and revoke the test session.

`npm run test:deployment` uses mocked APIs and does not establish real permissions. `npm run check` uses local workerd; production-configuration dry-runs only validate packaging. Cross-location propagation, cloud concurrency recovery and long-lived browser caching need separate tests. Platform request/storage limits still apply when product capacity limits are omitted; check limits and costs for the actual account and Zone.

Agent setup on a brand-new account needs its own acceptance test; verification of an existing installation does not establish it. Monitor Workers Logs/Metrics and D1/KV/R2/AE usage without logging tokens or file contents.
