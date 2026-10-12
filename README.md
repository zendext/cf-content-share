# cf-content-share

单人自部署的内容分享服务：把网址变成短链，把图片和文件上传后生成分享链接，通过 MCP 让 Agent 管理内容、搜索资源和查询访问统计。持有链接即可访问；管理操作需要登录，不提供独立管理网页。

## 使用的 Cloudflare 基础设施

| 服务 | 用途 |
| --- | --- |
| Workers（Rust / Wasm） | MCP 接口、短链跳转和流式上传／下载 |
| D1 | 资源元数据、上传会话、容量和操作状态 |
| Workers KV | 分享 ID 到资源的映射 |
| R2（Standard 私有桶） | 图片和文件正文 |
| Analytics Engine | 访问事件与最近 30 天的统计查询 |
| Access + Managed OAuth | 管理员登录和 MCP 客户端授权 |
| Cache API / Cron Triggers | 正文缓存／每 5 分钟恢复未完成操作、清理数据 |
| DNS + Worker Route | 把自己的域名接入服务 |

## 手动安装

需要 Node.js 22+、Rust stable（支持 edition 2024），以及已接入 Cloudflare 的域名。先在账户中开通所需的 Workers、R2、Analytics Engine 和 Zero Trust 服务；产品套餐、额度和计费分别适用。

### 1. 创建 Cloudflare API Token

在 [API Tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token → Create Custom Token 创建 Token。下面的权限用于**同一个 Token 完成初始化、部署和统计查询**：

| 范围 | 权限 | 级别 |
| --- | --- | --- |
| Account | Workers Scripts | Edit |
| Account | D1 | Edit |
| Account | Workers KV Storage | Edit |
| Account | Workers R2 Storage | Edit |
| Account | Account Analytics | Read |
| Zone | Workers Routes | Edit |
| Zone | Zone | Read |

Account Resources 只选择部署账户，Zone Resources 只选择分享域名所属 Zone。DNS 和 Access 在控制台手动配置，因此此流程不需要给 Token 添加 DNS 或 Access 写权限。权限名称见 [Cloudflare 权限表](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)，统计查询使用 [Account Analytics Read](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)。这里需要 Cloudflare API Token，不是 Access Service Token、OAuth 登录令牌或 R2 S3 密钥。

一个 Token 可以完成上述流程，但作为 Worker Secret 后也保有部署写权限。长期使用建议另建只有 `Account → Account Analytics → Read` 的 Token，作为 `ANALYTICS_API_TOKEN`；部署 Token 只留在本机。用于统计的 Token 不能限制为仅允许本机出口 IP，否则 Worker 查询会被拒绝。

### 2. 准备域名、Access 和配置

在 Cloudflare 控制台为分享域名准备 **proxied（橙云）DNS 记录**。本项目生成的是 Worker Route（`share.example.com/*`），DNS 不由安装脚本创建。无源站的新子域名可使用 proxied AAAA `100::` 占位，业务由 Worker 全部处理；不要改动其他服务正在使用的记录。参见 [Route 要求](https://developers.cloudflare.com/workers/configuration/routing/routes/)和[无源站 DNS 占位说明](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

在 Zero Trust 创建 Self-hosted Access 应用，只保护 `share.example.com/mcp`，Allow 策略只允许本人邮箱，并启用 **Managed OAuth**；本地 Agent 还需允许 localhost / loopback 回调。记录团队 issuer（`https://<team>.cloudflareaccess.com`）与应用 AUD。详细步骤见[Access 配置](docs/deployment.md#3-access-与-managed-oauth-一次性配置)。

```sh
git clone <repository-url>
cd cf-content-share
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$PWD/target"
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
npm ci
umask 077
cp deployment.example.json deployment.local.json
chmod 600 deployment.local.json
```

编辑 `deployment.local.json`：填写自己的 `account_id`、`public_origin`、`zone_name`、`access_issuer` 和 `access_aud`；Worker 名和资源前缀可保留默认值。不要保留全零 ID，也不要把 Token 写进 JSON。可选容量与配置字段见[部署文档](docs/deployment.md#1-配置和部署身份)。

### 3. 初始化并部署

下面命令在 Bash / Zsh 中执行。读取 Token 时不回显，也不把明文写入命令历史；不要开启 shell 调试回显（`set -x`）。

```sh
# 执行 read 后粘贴 Token，再按回车。
read -r -s CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN
# 先查看计划，再创建资源。
npm run init:cloud -- --config deployment.local.json
npm run init:cloud -- --config deployment.local.json --apply
npm run check
npx wrangler deploy --dry-run --config wrangler.cloud.json
npx wrangler d1 migrations apply DB --remote --config wrangler.cloud.json
# 单 Token 安装：将同一个 Token 存为统计查询 Secret。
printf '%s' "$CLOUDFLARE_API_TOKEN" | npx wrangler secret put ANALYTICS_API_TOKEN --config wrangler.cloud.json
npx wrangler deploy --config wrangler.cloud.json
unset CLOUDFLARE_API_TOKEN
```

初始化会复用或创建 D1、KV 和私有 R2，生成 `wrangler.cloud.json`；不带 `--apply` 时只读预览。首次 `secret put` 可能提示创建同名占位 Worker，核对名字后继续。若使用独立统计 Token，把上面的 Secret 命令换成 `npx wrangler secret put ANALYTICS_API_TOKEN --config wrangler.cloud.json`，按提示粘贴只读 Token。Analytics Engine dataset 在首次写入事件后创建。

本地部署输入、生成配置和 `.dev.vars*` 已忽略；Token 文件、OAuth 凭据、上传会话 JSON 和数据库备份应保存在仓库外。升级、备份与回滚见[部署与升级](docs/deployment.md)。

### 4. 连接 Agent

以 Codex 为例，替换为自己的域名：

```sh
codex mcp add cf-content-share --url https://share.example.com/mcp
codex mcp login cf-content-share
```

完成浏览器登录后，让 Agent 创建短链或分享文件，再用未登录浏览器打开分享 URL，并查询统计。只有本人能调用管理接口，匿名分享应可访问；无有效上传会话的 `/upload` 请求应被拒绝。部署成功本身不等于这些流程已验证。

## 安装 Agent Skill

仓库提供 [cf-content-share Skill](skills/cf-content-share/SKILL.md) 和无 npm 依赖的[上传脚本](skills/cf-content-share/scripts/upload.mjs)。将整个 `skills/cf-content-share` 目录复制到 `~/.agents/skills/cf-content-share`，保留 `scripts/` 子目录；已有同名安装时先核对，不直接覆盖。Skill 需要 Node.js 22+ 和已登录的 MCP 连接。

典型请求：`用 $cf-content-share 把这个 PDF 分享出去，标题为“会议资料”`。Skill 指导 Agent 通过 MCP 创建会话，再用 HTTP 上传正文；安装 Skill 不会自动上传文件。上传结果不明时按 Skill 查询原操作，不要直接重新上传。

## 本地开发与文档

```sh
npm run db:migrate:local
npm run dev
```

`wrangler.local.jsonc` 使用占位资源，不含生产 Route。本地 MCP 仍验证 Access JWT；`npm run check` 使用独立测试密钥和本地 workerd，覆盖服务、部署初始化及上传脚本，不连接云端。`npm run dry-run` 检查本地配置与发布包。

- [产品需求](docs/requirements/product.md)、[技术设计](docs/design/technical.md)
- [文件与恢复](docs/files.md)、[访问统计](docs/analytics.md)
- [部署与升级](docs/deployment.md)、[实现进度](docs/plan/implementation.md)
- [正式服务云端验收](docs/research/2026-10-11-formal-cloud-acceptance.md)、[兼容性实验记录](docs/research/2026-10-11-rust-wasm-compatibility.md)
