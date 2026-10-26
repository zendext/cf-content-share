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
4. Enable **Managed OAuth**, allowing localhost, loopback or explicit HTTPS redirect URIs as required by the actual clients. Set the OAuth access-token lifetime to `15m` and grant-session duration to `336h` (14 days), and verify silent refresh. The grant duration controls when users must log in again; it does not make individual access tokens last 14 days. Copy the team issuer and Application Audience (AUD).
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

Verify configuration, bindings and domain before execution. Enter these commands step by step in Bash / Zsh without `set -x`; pasting the token at `read` keeps it out of command history.

```sh
read -r -s CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN
npm run check
npx wrangler deploy --dry-run --config wrangler.cloud.json
npx wrangler d1 migrations list DB --remote --config wrangler.cloud.json
npx wrangler d1 migrations apply DB --remote --config wrangler.cloud.json
npx wrangler secret put ANALYTICS_API_TOKEN --config wrangler.cloud.json < /private/analytics-api-token
npx wrangler deploy --config wrangler.cloud.json
unset CLOUDFLARE_API_TOKEN
```

When explicitly choosing one token, replace the Secret command with `printf '%s' "$CLOUDFLARE_API_TOKEN" | npx wrangler secret put ANALYTICS_API_TOKEN --config wrangler.cloud.json`. Agents reading private token files must pass credentials only through child-process environments and stdin, without printing them.

Migrations run in 0001, 0002, 0003 order and are deduplicated by Wrangler records. Never rewrite applied migrations. Resources automatically receive their deadline at first publication. If the first Secret write needs a placeholder Worker, verify its name.

Read back the Worker version, bindings, Route, Secret names and Cron. Connect MCP and complete real browser OAuth, then follow [deployment verification](#verify-the-deployment) and install the [sharing Skill](../../skills/cf-content-share/SKILL.md). Plans and dry-runs do not prove deployment or end-to-end success.

## Routine upgrades

Check the final code with `npm run check` and a dry-run using production configuration. Inspect migration lists, bindings, Route, Secret names, Cron, capacity and existing resources. Evaluate compatibility and back up before any required migration. With no new migration, deploy only the Worker; do not reinitialize resources. Update the Skill and helper together. Keep version and verification records in a private directory outside the repository.

## Verify the deployment

Verify real MCP calls, administrator login and rejection of other identities, OAuth refresh/revocation, anonymous sharing, rejection of invalid upload tokens, download digests, deletion/recovery, event statistics and timezones, and actual Cron execution. Verify default, custom and permanent retention, deadline rejection for short-lived GET/HEAD/Range requests and file cleanup. Delete test resources and revoke the test session.

`npm run test:deployment` uses mocked APIs and does not establish real permissions. `npm run check` uses local workerd; production-configuration dry-runs only validate packaging. Cross-location propagation, cloud concurrency recovery and long-lived browser caching need separate tests. Platform request/storage limits still apply when product capacity limits are omitted; check limits and costs for the actual account and Zone.

Agent setup on a brand-new account needs its own acceptance test; verification of an existing installation does not establish it. Monitor Workers Logs/Metrics and D1/KV/R2/AE usage without logging tokens or file contents.
