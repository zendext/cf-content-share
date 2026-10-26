# cf-content-share

English · [简体中文](README.zh-CN.md)

A self-hosted, single-user sharing service on Cloudflare. Turn URLs into short links, upload images and files, and let an agent manage content and query visit statistics through MCP. Anyone with a share link can access it; management requires authentication. There is no separate administration UI.

Resources expire 30 days after their first publication by default. Choose a custom lifetime or permanent storage when creating a resource, or change its deadline before it expires. Expiration stops new server requests and schedules cleanup; downloaded or browser-cached copies cannot be recalled.

## Infrastructure

| Service | Purpose |
| --- | --- |
| Workers (Rust / Wasm) | MCP, redirects, streamed uploads and downloads |
| D1 | Resource metadata, operations and capacity accounting |
| Workers KV | Public resource mappings |
| R2 (private Standard bucket) | Image and file contents |
| Analytics Engine | Visit events and queries over the last 30 days |
| Access + Managed OAuth | Administrator login and MCP client authorization |
| Cache API / Cron Triggers | Content caching / recovery and cleanup every five minutes |
| DNS + Worker Route | Your sharing domain |

## Deploy with an agent

Clone this repository and give the following prompt to an agent with terminal and network access. Replace the placeholders and save your API token in a file outside the repository with permissions `0600`.

```text
Install and deploy cf-content-share using docs/en/deployment.md in this repository.

Cloudflare account ID: <account ID>
Sharing domain: <share.example.com>; Zone: <example.com>
Administrator email: <your email>
Zero Trust team: <existing team name, or desired name for a new team>
Cloudflare API token file: <absolute path outside the repository, mode 0600>

You may install the required tools, create missing project resources, configure
its dedicated DNS, Access and Managed OAuth, apply migrations, set the analytics
Secret and deploy the Worker. Inspect existing resources and reuse exact matches.
Do not overwrite other services, weaken admission policies or delete existing data.
Use a separately provided Account Analytics Read token for analytics if available;
otherwise use the deployment token as ANALYTICS_API_TOKEN.
Never put tokens in chat, command arguments, logs or tracked files.

Connect my MCP client, install the bundled sharing Skill, and verify login,
short links, uploads/downloads and analytics. I will complete browser login.
Report missing permissions or service activation requirements; do not widen
permissions or buy plans. Report what passed and what remains unverified.
```

The agent combines the initialization script, Cloudflare APIs and Wrangler; this is not a one-command installer. You need Node.js 24.12+, rustup, a Cloudflare-managed domain and access to the services above. Token creation, any required service activation and browser login remain user actions. See the [deployment guide](docs/en/deployment.md) for permissions, manual commands and upgrades.

## Install the agent Skill

Copy the entire [`skills/cf-content-share`](skills/cf-content-share/SKILL.md) directory, including `scripts/`, into `~/.agents/skills/cf-content-share`. Inspect an existing installation before replacing it. The Skill needs Python 3.12+ and an authenticated MCP connection; check interpreter capabilities as the Skill describes. Its [upload helper](skills/cf-content-share/scripts/upload.py) uses only the standard library, without npm, pip or a virtual environment.

Example request: “Use $cf-content-share to share this PDF, title it ‘Meeting notes’, and keep it for seven days.” The agent discovers the current upload contract, saves the operation, uploads over HTTP, and checks the authoritative result through MCP. Installing the Skill does not upload anything. Update the Skill and helper together; compatible business-schema changes are discovered from the service.

## Local development

`rust-toolchain.toml` pins Rust, the Wasm target, rustfmt, Clippy and rust-analyzer. Use Node.js 24.12+ and Python 3.12+; CI uses Node.js 24.21.0 and Python 3.12.

```sh
python -c "import sys, ssl, hashlib, http.client; assert sys.version_info >= (3, 12)"
npm ci
cargo install worker-build --version 0.8.7 --locked
npm run db:migrate:local
npm run dev
```

`wrangler.local.jsonc` contains placeholders and no production Route. Local MCP still validates Access JWTs. The test suite uses its own keys and local workerd instances; it does not require cloud credentials.

| Command | Purpose |
| --- | --- |
| `npm run format` | Biome formatting, import organization and safe fixes, then Rust formatting |
| `npm run lint` | Biome, Rust formatting and Wasm Clippy; warnings fail |
| `npm run check:types` | Strict TypeScript checks for Node and workerd |
| `npm run check` | Lint, type checking, Wasm build and all tests |
| `npm run dry-run` | Validate the local deployment bundle without publishing |

Platform development scripts and fixtures use `.mts`, executed by Node's native type stripping. Generated JavaScript and dependencies are untracked; source-policy tests reject maintained JavaScript files. The standalone upload helper uses Python standard-library code; `npm run check:upload` compiles it and runs unittest. Upload-client CI runs on Linux x86_64/arm64, macOS arm64 and Windows x86_64. GitHub Actions runs the same checks and a local dry-run on pull requests and pushes to `main`. VS Code settings support Biome and rust-analyzer; other editors can use the same tools.

## Documentation

- [Usage and MCP operations](docs/en/usage.md)
- [Deployment and upgrades](docs/en/deployment.md)
- [Architecture and consistency](docs/en/architecture.md)
- [Files, OAuth uploads and recovery](docs/en/files.md)
- [Analytics](docs/en/analytics.md)

Every guide has a matching Chinese version. Chinese is the authoritative source; update both languages together.

## License

Copyright 2026 cf-content-share contributors. Licensed under [Apache-2.0](LICENSE).
