# 部署与升级

[English](../en/deployment.md) · [文档入口](../../README.zh-CN.md#文档)

## 准备工具和身份

从项目根目录执行命令。需要 Node.js 24.12+、rustup、已接入 Cloudflare 的域名，以及 Workers、D1、KV、R2、Analytics Engine、Zero Trust 的使用权限。Rust 版本与组件由 `rust-toolchain.toml` 固定。

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

在 [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) 创建 Custom Token，账户范围只选目标账户，Zone 范围只选目标 Zone：

| 范围 | 权限 | 级别 |
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

DNS 和两项 Access 写权限用于 Agent 配置；若手动配置，可去掉对应权限。统计建议另用只有目标账户 Account Analytics Read 的 Token；若复用部署 Token，运行时 Secret 也拥有部署写权限。统计 Token 不要限制为仅本机出口 IP。R2 S3 凭据不能替代 Cloudflare API Token。

Token 放在仓库外普通文件中，权限必须为 `0600`，通过 `--token-file /private/cloudflare-api-token` 交给脚本；也可以使用 `CLOUDFLARE_API_TOKEN` 环境变量。不要把明文放进命令参数、聊天、日志或 Git。`--token-file` 不会替 Wrangler 保存登录状态；Wrangler 需要子进程环境中的 Token 或其自身登录。

## Access、DNS 与配置

先回读现有 Zone、DNS、Workers、Access 组织、IdP、应用和资源。复用匹配项，403 不能当作不存在；遇到其他服务占用或重叠策略时停止并说明冲突。

1. 复用现有 Zero Trust 团队，不重命名或重建。缺失时按使用者指定的团队名创建。
2. 复用或添加 Cloudflare IdP，启用 **Restrict to account members**。准入邮箱必须属于账户，不自动放宽策略。
3. 建立 Self-hosted Access 应用，只保护分享主机的 `mcp` 路径。唯一 Allow 策略用 **Emails** 指定本人完整邮箱，只选择上述 IdP。检查父级应用未拦截 `/r/*`、`/upload` 和 OAuth 发现路径；不使用 Everyone、宽泛邮箱域或 Bypass 代替个人认证。
4. 启用 **Managed OAuth**，按实际客户端需要允许 localhost、loopback 或明确的 HTTPS redirect URI。将 OAuth access token 期限设为 `15m`、grant session 期限设为 `336h`（14 天），验证静默刷新。grant 期限决定何时需要重新登录，不代表单份 access token 有效 14 天。复制团队 issuer 与 Application Audience (AUD)。
5. 分享主机使用 proxied DNS 和 `<host>/*` Worker Route；专用无源站子域名可使用 AAAA `100::` 占位。现有不同目标、Route 或 Custom Domain 不直接覆盖。DNS 与 Access 需要通过控制台或 API 单独配置，初始化脚本不处理它们。

参考：[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)、[IdP](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/)、[Access 路径](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)、[Worker Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)。

填写 `deployment.local.json`，替换所有全零或示例占位值：

| 字段 | 约定 |
| --- | --- |
| `account_id` | 32 位小写十六进制账户 ID |
| `worker_name` / `resource_prefix` | Worker 名与资源前缀 |
| `d1_name` / `kv_name` / `r2_name` | 可选精确名称；3–63 位小写字母、数字、连字符，首尾字母或数字 |
| `analytics_dataset` | 可选；字母开头，随后字母、数字、下划线，最长 64 位 |
| `public_origin` / `zone_name` | `https://share.example.com` / `example.com`；origin 不带路径、端口或尾部斜线 |
| `access_issuer` / `access_aud` | `https://<team>.cloudflareaccess.com` / 64 位应用 audience |
| `default_timezone` | 默认 `Asia/Shanghai`，使用 IANA 时区名称 |
| `max_file_bytes` / `total_storage_bytes` | 可选非负十进制整数字符串，最大 `9007199254740991`；`"0"` 明确限制为零，省略不设产品上限 |

D1、R2 默认使用前缀，KV 使用 `<prefix>-mappings`，统计数据集默认把前缀的连字符转成下划线。输入与生成的 `wrangler.cloud.json` 均已忽略；自选路径应自行加入本地忽略规则。配置不包含 Token、邮箱或 OAuth 客户端凭据。

## 初始化资源

```sh
npm run init:cloud -- --config deployment.local.json --token-file /private/cloudflare-api-token
npm run init:cloud -- --config deployment.local.json --token-file /private/cloudflare-api-token --apply
```

第一条仅 GET，不写文件；第二条创建缺失的 D1/KV/R2，并原子写入权限 `0600` 的配置。可用 `--output` 指定已有父目录中的路径；入口和迁移路径相对输出计算，构建从项目根目录执行。脚本不迁移、不部署、不配置 Secret、Access、DNS 或云端 Route；生成的 Route 配置由部署应用。

脚本读取完整分页后精确匹配资源名称。新桶指定 Standard；已有桶也必须明确为 Standard，且 `r2.dev` 与自定义域名均未公开。未知存储类型、公开状态、重复名称或旧输出绑定不一致都会停止，不自动修复已有资源。旧输出中的未知自定义配置也拒绝覆盖；常规设置应修改输入文件，不删除输出来绕过冲突。

失败可能留下已创建资源；先重新运行只读计划，再 `--apply` 复用。脚本不盲目重试创建，也不删除现有数据。并发使用输出旁 `.lock`；只有确认初始化进程已退出才手动移除遗留锁，不并行初始化同一组资源。

生成配置含 DB、MAPPINGS、FILES、ANALYTICS 及所需变量，五分钟 Cron，禁用 workers.dev 和 preview URLs。Analytics Engine 数据集在首次事件写入后创建；初始化本身不产生统计数据。

## 首次发布

核对配置、绑定和域名后执行。以下示例在 Bash / Zsh 逐步输入，不开启 `set -x`；`read` 时粘贴 Token 不会进入命令历史。

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

若明确使用同一 Token，Secret 命令可替换为 `printf '%s' "$CLOUDFLARE_API_TOKEN" | npx wrangler secret put ANALYTICS_API_TOKEN --config wrangler.cloud.json`。Agent 从私有文件读取 Token 后仅通过子进程环境和 stdin 传递，不打印它。

迁移按 0001、0002、0003 顺序应用，由 Wrangler 记录去重，不改写已执行的迁移。资源在首次发布时自动确定有效期。首次设置 Secret 若需建立占位 Worker，先核对名称。

回读 Worker version、绑定、Route、Secret 名称与 Cron。连接 MCP 并完成真实浏览器 OAuth，再按[验证部署](#验证部署)验收，安装[分享 Skill](../../skills/cf-content-share/SKILL.zh-CN.md)。CLI 计划与 dry-run 都不代表真实部署或端到端成功。

## 常规升级

检查最终代码并完成 `npm run check` 和正式配置 dry-run。核对迁移列表、现有绑定、Route、Secret 名称、Cron、容量和原资源；需要迁移时先评估兼容性并备份。无新迁移时只发布 Worker，不重复初始化资源。更新 Skill 时同步脚本。保留版本和验证记录在仓库外私有目录。

## 验证部署

至少验证实际 MCP 调用、本人登录与其他身份拒绝、OAuth 刷新／撤销、匿名分享、无效上传 Token 拒绝、文件下载摘要、删除与恢复、统计事件及时区、真实 Cron 执行。验证默认、自定义和永久保存策略、短期资源 GET/HEAD/Range 到点拒绝与文件清理，清理测试资源并撤销本次测试会话。

`npm run test:deployment` 使用模拟 API 验证初始化，不证明真实权限。`npm run check` 使用本地 workerd；正式配置 dry-run 只验证打包。跨节点传播、云端并发故障恢复及长期浏览器缓存需单独测试。Workers、R2 等平台请求与存储限制仍适用，省略容量配置不会绕过限制；按实际账户与 Zone 检查平台限制和费用。

首次全新账户的 Agent 编排需要单独验收，不能把已有安装的验证当作全新账户验证。观察 Workers Logs/Metrics 及 D1/KV/R2/AE 用量，日志不含 Token 或文件正文。
