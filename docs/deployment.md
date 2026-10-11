# 正式服务部署与升级

本文对应根目录正式工程；资源初始化 CLI 已有模拟 Cloudflare API 回归，真实资源创建、正式 Worker 发布与云端验收应分别记录。原型的验证不能替代正式服务验收。全部命令从项目根目录运行；不要在 `prototypes/compat` 下执行正式迁移。

## 1. 配置和部署身份

安装仓库 README 指定的 Rust、Wasm target、worker-build 和 Node.js，并执行 `npm ci`。Wrangler 版本由 lockfile 固定。

```sh
cp deployment.example.json deployment.local.json
chmod 600 deployment.local.json
```

编辑 `deployment.local.json` 中的账户 ID、Worker 名、资源前缀、公开 origin、Zone 名、Access issuer 和 audience。示例的全零 ID 只是格式占位值，必须替换。输入与默认输出 `wrangler.cloud.json` 均已加入 `.gitignore`；自选其他路径时自行加入本地忽略规则。配置不得包含 API Token、邮箱或 OAuth 客户端凭据。

| 字段 | 约定 |
| --- | --- |
| `account_id` | 32 位账户 ID；不从当前登录账户猜测 |
| `worker_name` | 正式 Worker 名；新安装默认示例为 `cf-content-share` |
| `resource_prefix` | D1、R2 默认同名；KV 默认为 `<prefix>-mappings`；AE 默认把连字符替换为下划线 |
| `d1_name` / `kv_name` / `r2_name` | 可选的精确资源名覆盖；CLI 仅接受 3–63 位小写字母、数字、连字符，首尾字母或数字 |
| `analytics_dataset` | 可选；字母开头，随后字母、数字、下划线，最长 64 位 |
| `public_origin` / `zone_name` | 例如 `https://s.example.com` / `example.com`；origin 不带路径、端口或结尾斜线 |
| `access_issuer` / `access_aud` | 团队 `https://<team>.cloudflareaccess.com` 和应用 64 位 audience |
| `default_timezone` | 默认 `Asia/Shanghai`；使用 IANA 时区，不支持 `+08:00` 这类偏移表达 |
| `max_file_bytes` / `total_storage_bytes` | 可选非负十进制整数字符串，最大 `9007199254740991`；`"0"` 表示明确设为零；省略表示不设产品容量上限 |

初始化身份需在目标账户拥有 D1、Workers KV Storage、Workers R2 Storage 的读取权限；`--apply` 创建资源还需相应编辑权限。部署另外需要 Workers Scripts 编辑、目标 Zone 的 Workers Routes 编辑及 Zone 读取；Analytics Engine 绑定权限按平台要求配置。CLI 不配置 DNS 或 Access，因此初始化身份无需这些写权限。账户资源列表操作可能要求账户级范围，不能用仅对象读写的 R2 S3 凭据代替 Cloudflare API Token。按 [Cloudflare API 权限表](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) 核对当前名称和范围。

凭据从 `CLOUDFLARE_API_TOKEN` 读取，或显式传 `--token-file /private/cloudflare-api-token`。文件必须是普通文件、权限 `0600`，内容仅为 Token；CLI 不打印其内容，不接受 `--token <value>`。Token 文件放在仓库外。Wrangler 自身使用 `CLOUDFLARE_API_TOKEN` 或 `wrangler login` 的身份；CLI 的 `--token-file` 不会替 Wrangler 保存登录状态。

## 2. 查看计划与初始化

```sh
npm run init:cloud -- --config deployment.local.json --token-file /private/cloudflare-api-token
npm run init:cloud -- --config deployment.local.json --token-file /private/cloudflare-api-token --apply
```

第一条只发 GET，不创建资源、不写输出或锁文件。第二条才创建缺失的 D1/KV/R2 并原子写入 `0600` 的 `wrangler.cloud.json`。支持 `--output deploy/wrangler.cloud.json`，父目录须已存在；入口与迁移目录相对输出文件计算，构建仍从执行命令的项目根运行。CLI 不部署 Worker、不执行迁移、不配置 Secrets、Access、Route 或 DNS。

每次完整读取 D1/KV 分页和 R2 cursor 分页后精确匹配配置名；同名重复时报错。已有 D1/KV ID 与桶名会复用；新 R2 桶显式指定 Standard。复用或新建后均读取目标桶属性，只有明确返回 `storage_class: "Standard"` 才继续；InfrequentAccess 或缺少该字段时停止，不修改已有存储类型。另检查目标 R2 桶的 `r2.dev` 和自定义域名设置，任何公开入口启用或状态未知都会停止。不会读取其他桶的对象，也不会关闭已有桶公开入口、清空 KV、重建 D1、删除资源或改写对象。

已有输出的账户、Worker、D1/KV ID、R2 名和 AE dataset 必须与本次匹配一致。资源被外部删除或替换时拒绝重建／覆盖；输出含未知字段或嵌套自定义配置时也拒绝覆盖。输出是生成文件；长期普通配置修改写回输入 JSON。不要以删除输出配置绕过 ID 冲突，应先核对资源归属。

创建遇到网络中断、HTTP 错误或响应格式错误立即停止，已经创建的资源保留。先重新运行不带 `--apply` 的计划核对；下次应用会重新查询并复用已创建资源。脚本不会在一次调用内盲目重试 POST。错误仅包含操作、HTTP 状态、数字错误码，不回显 API 响应正文。并发操作使用输出旁的 `.lock`；进程被强制终止后，只有确认没有运行中的初始化进程才可手动删除该锁。不同输出文件仍可能相互竞争，禁止并行初始化同一组资源。

Analytics Engine 没有这里需要调用的建库 API：CLI 只生成 `ANALYTICS` binding 与 `ANALYTICS_DATASET`；平台在 Worker 首次写入后创建 dataset。初始化完成不代表已有统计数据。见 [Analytics Engine 初始化规则](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)。

生成配置还包含 `DB`、`MAPPINGS`、`FILES` binding、`CLOUDFLARE_ACCOUNT_ID`、`DEFAULT_TIMEZONE`、`PUBLIC_ORIGIN`、`ACCESS_ISSUER`、`ACCESS_AUD`；可选容量对应 `MAX_FILE_BYTES` / `TOTAL_STORAGE_BYTES`。Worker 入口为 `build/index.js`，兼容日期为 `2026-10-11`，Cron 为 `*/5 * * * *`，关闭 `workers.dev` 和 preview URLs。

## 3. Access 与 Managed OAuth 一次性配置

已有 `share.example.com/mcp` 应用应复用：团队 issuer 为 `https://example-team.cloudflareaccess.com`，audience 以 [原型配置](../prototypes/compat/wrangler.jsonc) 和控制台回读为准。不要为正式 Worker 再建一个覆盖相同路径的 Access 应用。本人邮箱不写入仓库；检查现有应用只有本人能通过，而不只是“所有 Cloudflare 账户成员”。

新安装在 Cloudflare Dashboard 完成以下步骤：

1. 在 Zero Trust → Integrations → Identity providers 查看已有 Cloudflare IdP；不存在时添加 Cloudflare，启用 **Restrict to account members** 并保存。[官方 IdP 步骤](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/)
2. 在 Zero Trust → Access controls → Applications 添加 Self-hosted 应用，Public hostname 填实际分享主机，Path 填 `mcp`。应用只保护 `/mcp`，不配置整个域名的统一登录要求；检查没有父级应用误拦截 `/r/*`、上传路径或 OAuth 发现路径。[路径规则](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
3. 配置唯一 Allow 策略，Include 使用 **Emails** 填本人完整邮箱。应用的登录方式只选择前一步的 Cloudflare IdP；不要添加 Everyone 或宽泛邮箱域 Include，也不要以 Bypass/Service Auth 代替个人 OAuth。
4. 应用 Advanced settings 启用 **Managed OAuth**。按客户端需要开启 **Allow localhost clients** 与 **Allow loopback clients**，云端客户端只加入其实际 HTTPS redirect URI。当前原型使用 15 分钟 access token、24 小时 grant session；保留已有设置，不假设新客户端能自动刷新。[Managed OAuth 设置](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
5. 从应用详情复制 **Application Audience (AUD)**，结合团队 issuer 写回部署输入；重新生成配置。Worker 会验证 `Cf-Access-Jwt-Assertion` 的签名、issuer 和 audience。不要把 OAuth opaque token 当作 Access JWT，也不要提取客户端私有凭据代替上传 Token。

验收时用实际 MCP 客户端连接 `https://<host>/mcp`：未登录应返回 401 和 OAuth `WWW-Authenticate`，客户端跟随实际发现地址完成注册、浏览器登录、回调和工具调用；本人能进入，其他邮箱被拒绝。分别验证刷新、撤销和每个实际客户端，不能用一次登录推断它们已通过。匿名 `/r/<id>` 可访问；无应用 Token 的上传请求被 Worker 拒绝，不能跳到 Access 登录页。

## 4. 迁移、Secrets 与发布

下面操作会修改云端状态，应在核对计划、数据库名和目标域名后单独执行。首次正式安装使用新正式资源；不要对原型数据库套用根目录迁移。

```sh
npm run test:deployment
npm run check
npx wrangler deploy --dry-run --config wrangler.cloud.json
npx wrangler d1 migrations list DB --remote --config wrangler.cloud.json
npx wrangler d1 migrations apply DB --remote --config wrangler.cloud.json
```

根目录迁移按 `migrations/0001_resources.sql` 起的版本顺序执行，后续 `0002_*.sql` 等增量迁移由 Wrangler 的迁移记录去重。已经应用的文件不得改写；重复执行不应重建数据库或改变已有资源 ID、对象 key 和分享 URL。

AE 查询使用单独的 Worker Secret `ANALYTICS_API_TOKEN`。在 API Tokens → Create Custom Token 创建目标账户 **Account → Account Analytics → Read** 的最小权限 Token；限制账户范围，避免使用初始化／部署的写权限 Token。见 [AE SQL API 身份认证](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)。先用下列只读查询核对权限（账户 ID 从本地配置读取，Secret 文件要求同样为 `0600`）：

```sh
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import { readToken } from './scripts/init-cloud.mjs';
const { account_id } = JSON.parse(await readFile('deployment.local.json', 'utf8'));
const token = await readToken('/private/analytics-api-token');
const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account_id}/analytics_engine/sql`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'SELECT 1 AS ok',
  redirect: 'error', signal: AbortSignal.timeout(30000),
});
console.log(`Analytics SQL HTTP ${response.status}`);
if (!response.ok) process.exitCode = 1;
JS
npx wrangler secret put ANALYTICS_API_TOKEN --config wrangler.cloud.json < /private/analytics-api-token
npx wrangler deploy --config wrangler.cloud.json
```

首次 `secret put` 若目标 Worker 不存在，Wrangler 会要求创建占位 Worker；先核对名字，再完成正式 deploy。记录 Worker version ID、Git commit 和迁移列表。`SELECT 1` 通过只证明 SQL 查询身份可用；首次公开访问产生事件之后，还需通过 MCP 统计查询核对 dataset、事件和时区。不要把 Secret 写入 `vars`、输入配置、命令参数或日志。

Route 固定生成为 `{ "pattern": "<host>/*", "zone_name": "<zone>" }`，不使用 `custom_domain`。DNS 独立维护。当前 `share.example.com` 是灰云 CNAME → `edge.example.net`，Route 指向 `cf-content-share-compat`；初始化不得替换、橙云化或删除此 DNS。现有组合是[实验记录](research/2026-10-11-rust-wasm-compatibility.md)中的实测状态；[官方 Route 文档](https://developers.cloudflare.com/workers/configuration/routing/routes/)仍要求 proxied DNS，不能把当前实测推广为平台长期保证。新域名按所选入口方案单独验收。

## 5. 原型切换和正式版本升级

**当前原型不是正式模型的升级起点。** 原型 D1/R2 都叫 `cf-content-share-compat`，原型链接使用 43 位 ID；正式模型使用 12 位 ID。不能把正式 Worker 直接绑定原型库，也不能只换 Route 就声称旧链接保留。`public`、`siyuan` 等其他桶与本项目无关。

首次上线先用独立正式资源和独立测试主机演练。保留现有生产 Route、原型数据库和对象，冻结切换前原型写入并导出记录和对象清单。若旧链接必须继续可用，必须先实现、评审和演练显式的旧 43 位路径兼容／映射方案（包含对象 key、元数据、完整性和回滚核对）；当前初始化 CLI 不提供该转换。未完成这一迁移前不切换 `share.example.com/*`。如果明确选择放弃原型测试链接，也需逐项确认保留和删除范围，再安排 Route 切换；不能默认清空原型。正式 v1 之后的版本升级才适用下面的同模型流程。

升级前暂停业务写入及可能改变状态的 Cron，确保没有进行中的上传／恢复任务；记录配置、Git commit、当前 Worker version、D1 migration 列表和 R2 对象清单。用当前正式绑定导出 D1 SQL，输出保存在仓库外：

```sh
umask 077
npx wrangler d1 export DB --remote --config wrangler.cloud.json --output /private/backup-before-upgrade.sql
npx wrangler deployments list --config wrangler.cloud.json
npx wrangler d1 migrations list DB --remote --config wrangler.cloud.json
npm run init:cloud -- --config deployment.local.json
npm run check
npx wrangler deploy --dry-run --config wrangler.cloud.json
npx wrangler d1 migrations apply DB --remote --config wrangler.cloud.json
npx wrangler deploy --config wrangler.cloud.json
```

复用同一 Worker、域名、资源 ID 和对象 key；部署后验证升级前 URL 仍能重定向／下载且摘要不变、`resource.get` / 列表和统计可用、Cron 正常，再恢复写入。迁移优先使用兼容旧代码的加法变更；移除列或改变语义需要单独迁移设计和恢复演练。

代码回滚使用 `npx wrangler rollback <已记录的旧版本ID> --config wrangler.cloud.json`，前提是旧代码兼容当前 schema。**代码回滚不会回滚 D1 数据或 R2 对象。** 如需数据恢复，继续停写；在独立恢复数据库及配置上用 `wrangler d1 execute DB --remote --file /private/backup-before-upgrade.sql --config <恢复配置>` 演练导入，核对数量、资源 ID、对象 key、迁移记录和对象摘要后，再制定有审阅记录的恢复切换。不要把全量 SQL 直接导入正在使用的非空生产库，也不要靠删库／重建来撤销迁移。D1 还提供 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)；应先核对可恢复时点及窗口，回滚期间所有数据变更都会受影响。SQL 和 Time Travel 都不备份 R2，恢复前必须核对对象仍存在。

## 6. 验收和可观测性

`npm run test:deployment` 使用内存 API 和临时目录验证计划无写入、首次创建、分页、重入、部分失败恢复、旧 ID 保护、私有桶校验、凭据脱敏和路径生成。它不证明真实账户权限、云端资源创建、Access 登录、Route 切换或 AE 数据可见性。`deploy --dry-run` 只证明配置可解析和构建包可生成，也不会发布。

每次云端验收至少记录真实 MCP 工具调用、匿名旧／新分享访问、有效及无效上传 Token、文件下载摘要、删除与恢复任务、统计事件及默认时区、Cron 触发和告警状态。结合 Workers Logs/Metrics、D1/KV/R2/AE 用量观察失败和费用；日志不得包含 Token 或文件正文。

当前生产 Zone 的 Free Website 请求体上限为 100 MB，包含 multipart 开销；Workers Paid 不提高该上限。原型云端 32 MiB、本地 workerd 160 MiB 是不同证据，后者不能证明当前域名能接收 160 MiB。容量配置省略也不会绕过平台限制。见 [Workers 请求限制](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits)。

2026-10-11 的真实只读计划预检中，D1 列表读取成功，KV namespace 列表返回 HTTP 401、错误码 10000，因此在任何创建前停止。当前凭据尚需补齐目标账户 Workers KV Storage 权限后重试；这属于权限配置与云端验证缺口，不是已完成真实初始化的证据。本次未产生云端写入。

CLI API 契约依据：[D1 数据库 API](https://developers.cloudflare.com/api/resources/d1/subresources/database/)、[KV namespace API](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/)、[R2 桶列表及 cursor](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/list/)、[R2 桶属性和 storage_class](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/get/)、[R2 managed domain](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/subresources/managed/methods/list/)、[R2 custom domains](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/subresources/custom/methods/list/)。
