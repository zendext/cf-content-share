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
4. 启用 **Managed OAuth**，按实际客户端需要允许 localhost、loopback 或明确的 HTTPS redirect URI。明确配置 access token 和 grant session 的期限，验证刷新能力。复制团队 issuer 与 Application Audience (AUD)。
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

核对配置、绑定和域名后执行。以下示例在 Bash / Zsh 逐步输入，不开启 `set -x`；`read` 时粘贴 Token 不会进入命令历史。已有数据且首次启用有效期的安装须改走后面的维护流程。

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

若明确使用同一 Token，Secret 命令可替换为 `printf '%s' "$CLOUDFLARE_API_TOKEN" | npx wrangler secret put ANALYTICS_API_TOKEN --config wrangler.cloud.json`。Agent 从私有文件读取 Token 后仅通过子进程环境和 stdin 传递，不打印它。

迁移按 0001、0002、0003 顺序应用，由 Wrangler 记录去重，不改写已执行的迁移。0003 准备列、索引、触发器和旧删除原因，不启动旧资源倒计时。发布兼容 Worker 后才激活；新安装即使没有旧资源，也应在开放业务前保存唯一 T0。首次设置 Secret 若需建立占位 Worker，先核对名称。

回读 Worker version、绑定、Route、Secret 名称与 Cron。连接 MCP 并完成真实浏览器 OAuth，再按[验证部署](#验证部署)验收，安装[分享 Skill](../../skills/cf-content-share/SKILL.zh-CN.md)。CLI 计划与 dry-run 都不代表真实部署或端到端成功。

## 常规升级

检查最终代码并完成 `npm run check` 和正式配置 dry-run。核对迁移列表、现有绑定、Route、Secret 名称、Cron、容量和原资源；需要迁移时先评估兼容性并备份。无新迁移时只发布 Worker，不重复初始化资源或重设 T0。更新 Skill 时同步脚本。保留版本和验证记录在仓库外私有目录。

## 旧安装首次启用有效期

已有数据从不支持有效期的版本升级时，采用短维护窗口。目录 `0700`、备份文件 `0600`，以下 `release_dir` 为需要预先创建的仓库外私有目录。

### 1. 维护与冻结构建

完成检查后冻结最终 `build/index.js` 和 `build/index_bg.wasm`。准备三份私有 Wrangler 配置，保持相同 name/account/Route/bindings/vars/Cron，仅入口不同；main 与 migrations_dir 使用绝对路径，移除 build 命令，避免分阶段重建：

- `wrangler.production.json` 指向最终构建。
- `wrangler.maintenance-only.json` 指向静态维护入口。
- `wrangler.compatible-maintenance.json` 指向加载最终构建但禁止业务的维护入口。

静态维护入口：

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

兼容维护入口（替换真实构建路径）：

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

先用本地 workerd 验证两者的 GET/HEAD/POST、响应头及 scheduled，不触发业务或外部请求。Access 保持原样，未认证请求可能先收到 401，不增加认证旁路。

```sh
umask 077
release_dir=/private/cf-content-share-release
sha256sum build/index.js build/index_bg.wasm > "$release_dir/bundle.sha256"
npx wrangler deploy --dry-run --config "$release_dir/wrangler.maintenance-only.json"
npx wrangler deploy --dry-run --config "$release_dir/wrangler.compatible-maintenance.json"
npx wrangler deploy --dry-run --config "$release_dir/wrangler.production.json"
npx wrangler deploy --config "$release_dir/wrangler.maintenance-only.json"
```

确认维护版本承接 100% 流量并返回 503；发布不能终止旧请求，须等待在途上传／恢复耗尽并检查活动租约、操作与容量。仅关闭 MCP 客户端不能阻止上传；仅移除 Cron 配置也不能视为立即停用。维护入口的 scheduled 应保持不执行业务。

### 2. 备份与 Schema

先核对原资源状态、数量、容量、R2 对象清单与摘要，再备份 D1、迁移记录和恢复书签；D1 导出可能阻断查询，应在维护窗口执行。

```sh
npx wrangler deployments list --config "$release_dir/wrangler.production.json"
npx wrangler d1 migrations list DB --remote --config "$release_dir/wrangler.production.json"
npx wrangler d1 time-travel info DB --config "$release_dir/wrangler.production.json"
npx wrangler d1 export DB --remote --config "$release_dir/wrangler.production.json" --output "$release_dir/backup-before-upgrade.sql"
sha256sum "$release_dir/backup-before-upgrade.sql" > "$release_dir/backup-before-upgrade.sha256"
npx wrangler d1 migrations apply DB --remote --config "$release_dir/wrangler.production.json"
node scripts/activate-expiration.mts --config "$release_dir/wrangler.production.json"
```

首次预览应为 `activated=false`。若已激活，核对原 T0，不能删除记录重新计时。D1 备份不包含 R2 正文，需要恢复文件时必须另有对象备份。

### 3. 兼容发布与激活

```sh
sha256sum -c "$release_dir/bundle.sha256"
npx wrangler deploy --config "$release_dir/wrangler.compatible-maintenance.json"
```

确认新版本与维护状态后再激活：

```sh
node scripts/activate-expiration.mts --config "$release_dir/wrangler.production.json" --apply
node scripts/activate-expiration.mts --config "$release_dir/wrangler.production.json"
sha256sum -c "$release_dir/bundle.sha256"
npx wrangler deploy --config "$release_dir/wrangler.production.json"
```

激活脚本要求 `--config`，支持 `--env NAME`、`--token-file`；无 `--apply` 只读。单条 `INSERT OR IGNORE` 由 D1 生成 T0，trigger 在同一语句内记录迁移数量并为旧未删除资源（含 pending）设置 `T0 + 2592000`。晚到的旧格式插入也沿用 T0，旧 pending 发布不重设截止。

保存 `activated_at`、`legacy_expires_at`、`migrated_count` 并核对资源。响应丢失先只读查询；重复应用保留原 T0 与后续编辑。迁移数量只代表激活瞬间，晚到插入单独核对。禁止批量 UPDATE 重新计时或覆盖永久设置。恢复正式入口后验证旧链接、对象摘要、默认／自定义／永久资源、续期及自然到期清理。

### 4. 失败恢复

恢复失败时保持兼容维护，修复后发布同一已核对构建。激活后不能回滚不认识期限的 Worker；兼容回滚必须保留期限、KV 截止和删除规则。代码回滚不会恢复 D1/KV/R2，不要只凭 Schema 可读就认定兼容。

数据恢复期间停写，在独立数据库与配置上演练，核对 ID、对象 key、迁移、原 T0 和摘要。不要把完整 SQL 导入非空生产库，或删库重建撤销迁移；不能通过恢复重启 30 天倒计时。Time Travel 影响整个数据库，不备份 R2；没有对象副本时无法恢复已删除正文。

## 验证部署

至少验证实际 MCP 调用、本人登录与其他身份拒绝、OAuth 刷新／撤销、匿名分享、无效上传 Token 拒绝、文件下载摘要、删除与恢复、统计事件及时区、真实 Cron 执行。有效期激活还要验证原 T0 不变、短期资源 GET/HEAD/Range 到点拒绝与文件清理，清理测试资源并撤销本次测试会话。

`npm run test:deployment` 使用模拟 API 验证初始化，不证明真实权限。`npm run check` 使用本地 workerd；正式配置 dry-run 只验证打包。跨节点传播、云端并发故障恢复及长期浏览器缓存需单独测试。Workers、R2 等平台请求与存储限制仍适用，省略容量配置不会绕过限制；按实际账户与 Zone 检查平台限制和费用。

首次全新账户的 Agent 编排需要单独验收，不能把已有安装的验证当作全新账户验证。观察 Workers Logs/Metrics 及 D1/KV/R2/AE 用量，日志不含 Token 或文件正文。
