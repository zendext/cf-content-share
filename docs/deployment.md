# 正式服务部署与升级

本文对应根目录正式工程；资源初始化 CLI 已有模拟 Cloudflare API 回归，真实资源创建、正式 Worker 发布与云端验收应分别记录。原型的验证不能替代正式服务验收。全部命令从项目根目录运行；原型代码和环境已删除。

## 0. Agent 按提示词部署

README 的[安装提示词](../README.md#让-agent-安装)授权 Agent 执行本项目部署。它使用现有 CLI 与 Cloudflare API 组合完成；`init-cloud.mjs` 自身不会创建 DNS 或 Access。

1. 从用户提供的账户 ID、域名、准入邮箱、团队名和私有 Token 文件开始。用 `scripts/init-cloud.mjs` 的 `readToken` 读取凭据，在进程内通过 HTTPS Authorization header 调用固定的 Cloudflare API；不要把 Token 放进 shell 参数、打印原始响应或读取 Agent 的 OAuth 凭据文件。先回读目标 Zone、DNS、Workers、Access 组织／IdP／应用与资源列表，确认归属；403 不能当作资源不存在。
2. 复用现有 Zero Trust 组织。不存在时按用户提供的团队名创建；已有组织不得更名或重建。复用合适的 Cloudflare IdP，缺失时创建 `type=cloudflare` 且 `restrict_to_account_members=true` 的 IdP。本人准入邮箱须属于该 Cloudflare 账户；不符合时让用户提供可用身份，不自动放宽策略。按第 3 节配置仅保护 `/mcp` 的 self-hosted 应用、本人邮箱 Allow、Managed OAuth 和本地回调，读取 issuer 与 AUD。遇到重叠应用或不匹配的准入策略，先报告冲突，不覆盖其他应用。
3. 新分享子域名默认使用 proxied AAAA `100::` 与本项目生成的 `host/*` Worker Route。DNS 不存在时创建；若已有兼容记录则复用。已有不同目标、其他 Worker Route 或 Custom Domain 时报告冲突，不直接接管。公开 `/r/*`、`/upload` 与 OAuth 发现路径不能被整站 Access 登录规则拦截。
4. 检查并安装缺少的工具链与依赖，按下方步骤生成私有配置；先执行初始化只读计划，核对后 `--apply`。运行检查、dry-run 和 D1 迁移，按提示词选择单 Token 或用户另行提供的只读统计 Token，写入 `ANALYTICS_API_TOKEN` 后发布。不要创建新 API Token、购买套餐或重置现有数据；平台要求本人开通服务时报告具体缺项。
5. 回读 binding、Route、Secret 名称、Access 策略和 Cron，连接用户指定的 MCP 客户端并安装分享 Skill。浏览器 OAuth 登录交给用户，不索取密码或伪造用户登录。先发现客户端实际配置方式，不覆盖同名的其他连接。
6. 按第 6 节验证登录、匿名短链、上传下载摘要、统计与拒绝路径；清理本轮创建的测试资源和上传会话。报告实际通过与未验证项，不把 deploy 成功当作端到端验收。

Cloudflare API 参考：[组织](https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/)、[身份提供方](https://developers.cloudflare.com/api/resources/zero_trust/subresources/identity_providers/)、[Access 应用](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/)、[DNS 记录](https://developers.cloudflare.com/api/resources/dns/subresources/records/)、[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)。这些写操作需要 README 权限表中的 DNS 和两项 Access 编辑权限；手动配置时可省去它们。此编排文档经过代码和 API 契约核对，尚未在全新账户上端到端执行。

## 1. 配置和部署身份

先克隆本仓库并进入根目录。需要 Node.js 22+、Rust stable（支持 edition 2024）及 rustup；Wrangler 版本由 lockfile 固定。新环境执行：

```sh
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$PWD/target"
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
npm ci
umask 077
```

分享域名需已接入 Cloudflare，账户需具备 Workers、D1、KV、R2、Analytics Engine 和 Zero Trust 使用权限。手动安装先按第 3 节建立 Access 应用、取得 issuer 和 AUD，并准备目标域名的 proxied DNS；Agent 可按第 0 节完成这些 API 操作。

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

首次安装的完整 Token 权限表见 [README](../README.md#token-权限)。初始化身份需在目标账户拥有 D1、Workers KV Storage、Workers R2 Storage 的读取权限；`--apply` 创建资源还需相应编辑权限。部署另外需要 Workers Scripts 编辑、目标 Zone 的 Workers Routes 编辑及 Zone 读取；Analytics Engine 通过 Worker binding 写入，SQL 查询需要 Account Analytics 读取。CLI 不配置 DNS 或 Access；如果由 Agent 通过 API 配置它们，必须添加 README 中对应的写权限。账户资源列表操作使用目标账户范围，不能用仅对象读写的 R2 S3 凭据代替 Cloudflare API Token。

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

已有同域名 `/mcp` 应用时先核对并复用，从控制台或 API 取得实际团队 issuer 与 audience。不要创建覆盖相同路径的重复应用。本人邮箱只用于云端准入策略，不写入仓库；检查只有本人能通过，而不只是“所有 Cloudflare 账户成员”。

新安装在 Cloudflare Dashboard 完成以下步骤：

1. 在 Zero Trust → Integrations → Identity providers 查看已有 Cloudflare IdP；不存在时添加 Cloudflare，启用 **Restrict to account members** 并保存。[官方 IdP 步骤](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/)
2. 在 Zero Trust → Access controls → Applications 添加 Self-hosted 应用，Public hostname 填实际分享主机，Path 填 `mcp`。应用只保护 `/mcp`，不配置整个域名的统一登录要求；检查没有父级应用误拦截 `/r/*`、上传路径或 OAuth 发现路径。[路径规则](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
3. 配置唯一 Allow 策略，Include 使用 **Emails** 填本人完整邮箱。应用的登录方式只选择前一步的 Cloudflare IdP；不要添加 Everyone 或宽泛邮箱域 Include，也不要以 Bypass/Service Auth 代替个人 OAuth。
4. 应用 Advanced settings 启用 **Managed OAuth**。按客户端需要开启 **Allow localhost clients** 与 **Allow loopback clients**，云端客户端只加入其实际 HTTPS redirect URI。当前应用使用 15 分钟 access token、24 小时 grant session；保留已有设置，不假设新客户端能自动刷新。[Managed OAuth 设置](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
5. 从应用详情复制 **Application Audience (AUD)**，结合团队 issuer 写回部署输入；重新生成配置。Worker 会验证 `Cf-Access-Jwt-Assertion` 的签名、issuer 和 audience。不要把 OAuth opaque token 当作 Access JWT，也不要提取客户端私有凭据代替上传 Token。

验收时用实际 MCP 客户端连接 `https://<host>/mcp`：未登录应返回 401 和 OAuth `WWW-Authenticate`，客户端跟随实际发现地址完成注册、浏览器登录、回调和工具调用；本人能进入，其他邮箱被拒绝。分别验证刷新、撤销和每个实际客户端，不能用一次登录推断它们已通过。匿名 `/r/<id>` 可访问；无应用 Token 的上传请求被 Worker 拒绝，不能跳到 Access 登录页。

## 4. 迁移、Secrets 与发布

下面是新安装步骤，会修改云端状态，应在核对计划、数据库名和目标域名后单独执行。首次安装使用初始化入口生成的正式资源绑定；已有服务应用0003及首次激活必须走第5节维护窗口，不直接照抄新安装命令。

使用一个 Token 的完整命令如下，在 Bash / Zsh 逐步执行；不要开启 `set -x`。DNS 和 Access 须已配置。`read` 时粘贴 Token 后按回车，不将明文放入命令历史：

```sh
read -r -s CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN
npm run init:cloud -- --config deployment.local.json
npm run init:cloud -- --config deployment.local.json --apply
npm run check
npx wrangler deploy --dry-run --config wrangler.cloud.json
npx wrangler d1 migrations apply DB --remote --config wrangler.cloud.json
printf '%s' "$CLOUDFLARE_API_TOKEN" | npx wrangler secret put ANALYTICS_API_TOKEN --config wrangler.cloud.json
npx wrangler deploy --config wrangler.cloud.json
node scripts/activate-expiration.mjs --config wrangler.cloud.json
node scripts/activate-expiration.mjs --config wrangler.cloud.json --apply
unset CLOUDFLARE_API_TOKEN
```

使用 Token 文件的 Agent 也须在运行 Wrangler 的子进程环境中设置 `CLOUDFLARE_API_TOKEN`，向 `secret put` 的标准输入传入选定统计 Token；`--token-file` 可用于初始化和有效期激活脚本，不会替 Wrangler 保存登录状态。单 Token 方案使运行时 Secret 也拥有部署写权限；下方说明如何改用独立只读统计 Token。

分步核查与独立统计 Token 的操作如下：

```sh
npm run test:deployment
npm run check
npx wrangler deploy --dry-run --config wrangler.cloud.json
npx wrangler d1 migrations list DB --remote --config wrangler.cloud.json
npx wrangler d1 migrations apply DB --remote --config wrangler.cloud.json
```

根目录迁移按 `0001_resources.sql`、`0002_files.sql`、`0003_expiration.sql` 顺序执行，由 Wrangler 的迁移记录去重。已经应用的文件不得改写；重复执行不应重建数据库或改变已有资源 ID、对象 key 和分享 URL。0003准备有效期列、索引与触发器，补充旧删除原因，不开始旧资源30天倒计时；独立激活必须在新 Worker 成功部署后完成。即使新安装没有旧资源，也应在开放业务前预览并激活，保存唯一T0。

AE 查询使用 Worker Secret `ANALYTICS_API_TOKEN`。建议为新安装使用独立只读 Token；当前部署按用户明确要求复用既有部署 Token，只保存到 Worker Secret，不写入配置或日志。以下是新建只读 Token 的可选步骤。在 API Tokens → Create Custom Token 创建目标账户 **Account → Account Analytics → Read** 的最小权限 Token；限制账户范围，避免使用初始化／部署的写权限 Token。见 [AE SQL API 身份认证](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)。先用下列只读查询核对权限（账户 ID 从本地配置读取，Secret 文件要求同样为 `0600`）：

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

Route 固定生成为 `{ "pattern": "<host>/*", "zone_name": "<zone>" }`，不使用 `custom_domain`。DNS 独立维护。新安装按官方要求准备 proxied DNS；无源站专用子域名可用 AAAA `100::` 占位。已有安装若采用自定义入口，先核对其现状，不直接替换 DNS。曾验证过的灰云 CNAME 组合是[实验记录](research/2026-10-11-rust-wasm-compatibility.md)中的实测状态；[官方 Route 文档](https://developers.cloudflare.com/workers/configuration/routing/routes/)仍要求 proxied DNS，不能把当前实测推广为平台长期保证。新域名按所选入口方案单独验收。

## 5. 正式版本升级

原型已退役，升级和回滚只针对正式 Worker、域名与存储；不重建资源、不切回原型。本节区分准备 Schema、发布兼容代码和开始旧资源倒计时。已有服务首次启用有效期必须完成全套步骤；后续升级保留已存在的 T0，不重复初始化期限。

### 5.1 发布准备与维护门禁

先完成最终 `npm run check`，回读现有配置、Worker version、Route、Secret名称和Cron，核对D1/KV/R2绑定归属。记录旧资源数量、状态、容量、R2对象清单与摘要。配置、SQL备份、对象标识和发布记录保存在仓库外私有目录，目录0700、文件0600；不把Token或用户内容写入日志。

本次采用短维护窗口：所有到达Worker的fetch返回503、`Retry-After: 60`和`Cache-Control: no-store`，scheduled不执行业务。它同时隔离公开读取、MCP、HTTP上传和新触发的恢复任务；仅关闭MCP客户端不能阻止仍有效的上传会话。Access保持原样，未认证的受保护请求可能先返回401，不能为维护状态设置认证旁路。

在仓库外准备两个临时入口和三份私有Wrangler配置，不作为产品持久开关提交。三份配置保持相同name/account/Route/bindings/vars/Cron，仅main不同；把main、migrations_dir解析成绝对路径，并移除build命令，避免分阶段发布时重新构建。原生成配置不因此改写，也不要用init --apply覆盖手工发布配置。

- `wrangler.production.json`：main指向最终 `build/index.js`。
- `wrangler.maintenance-only.json`：main指向静态 `maintenance-only.mjs`。
- `wrangler.compatible-maintenance.json`：main指向加载同一最终bundle的 `compatible-maintenance.mjs`。

静态入口：

```js
export default {
  fetch(request) {
    return new Response(request.method === 'HEAD' ? null : 'Service temporarily unavailable.\n', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '60' },
    });
  },
  scheduled() {},
};
```

兼容维护入口用真实构建路径替换下例路径，保留构建的其他命名导出。它验证并打包新Wasm，fetch和scheduled仍不进入业务：

```js
import Worker from '/absolute/path/to/cf-content-share/build/index.js';
export * from '/absolute/path/to/cf-content-share/build/index.js';
export default class extends Worker {
  fetch(request) {
    return new Response(request.method === 'HEAD' ? null : 'Service temporarily unavailable.\n', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '60' },
    });
  }
  scheduled() {}
}
```

先用本地workerd验证两种入口的GET/HEAD/POST、响应头和scheduled，确认没有业务存储与外部请求。最终build停止变化后记录摘要，再分别dry-run；以下`/private/cf-content-share-release`是需替换的私有目录：

```sh
umask 077
release_dir=/private/cf-content-share-release
sha256sum build/index.js build/index_bg.wasm > "$release_dir/bundle.sha256"
npx wrangler deploy --dry-run --config "$release_dir/wrangler.maintenance-only.json"
npx wrangler deploy --dry-run --config "$release_dir/wrangler.compatible-maintenance.json"
npx wrangler deploy --dry-run --config "$release_dir/wrangler.production.json"
npx wrangler deploy --config "$release_dir/wrangler.maintenance-only.json"
```

回读维护版本为100%流量，并验证公开入口503。部署不能终止已经开始的旧请求；等待在途上传／恢复耗尽，复查活动lease、操作和容量。Cron表达式可以继续保留五分钟，维护scheduled不做事；如果另行删除Cron，不得把API空数组等同于即时停止，配置传播可能需要最多15分钟。[Cron传播规则](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

### 5.2 先备份，再准备 Schema

在维护隔离及旧执行核对后，先取得D1 SQL、Time Travel bookmark、迁移记录和R2对象证据，确认备份成功再迁移：

```sh
npx wrangler deployments list --config "$release_dir/wrangler.production.json"
npx wrangler d1 migrations list DB --remote --config "$release_dir/wrangler.production.json"
npx wrangler d1 time-travel info DB --config "$release_dir/wrangler.production.json"
npx wrangler d1 export DB --remote --config "$release_dir/wrangler.production.json" --output "$release_dir/backup-before-upgrade.sql"
sha256sum "$release_dir/backup-before-upgrade.sql" > "$release_dir/backup-before-upgrade.sha256"
npx wrangler d1 migrations apply DB --remote --config "$release_dir/wrangler.production.json"
node scripts/activate-expiration.mjs --config "$release_dir/wrangler.production.json"
```

首次预览应为`activated=false`；0003不写激活记录，也不为旧未删除行提前赋到期时间。若已经激活，核对原T0，不删除记录重新计时。D1导出可能暂时阻断数据库查询，因此在维护窗口执行。[导出API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)

### 5.3 兼容发布后显式激活

先发布加载新bundle的兼容维护版本，回读新version与503状态，成功后才执行激活：

```sh
sha256sum -c "$release_dir/bundle.sha256"
npx wrangler deploy --config "$release_dir/wrangler.compatible-maintenance.json"
node scripts/activate-expiration.mjs --config "$release_dir/wrangler.production.json" --apply
node scripts/activate-expiration.mjs --config "$release_dir/wrangler.production.json"
```

`activate-expiration.mjs`要求显式`--config`，可选`--env NAME`和`--token-file /private/token`；不带`--apply`只读。应用时单条`INSERT OR IGNORE INTO expiration_activation(id) VALUES(1)`由D1生成UTC Unix秒T0，插入触发器在同一语句内固定迁移数量并设置旧未删除资源`T0 + 2592000`，包含pending。新资源策略有显式版本；旧漏字段插入即使晚到也使用同一T0，旧pending后续发布不重设截止。

保存返回的`activated_at`、`legacy_expires_at`、`migrated_count`及迁移前后资源核对结果。`migrated_count`是T0瞬间迁移数量，晚到旧插入应另行核对。脚本响应丢失时先只读预览；重复`--apply`保留原T0和用户后续修改，不能手工批量UPDATE重新计时或覆盖永久设置。

确认激活完成后恢复同一bundle：

```sh
sha256sum -c "$release_dir/bundle.sha256"
npx wrangler deploy --config "$release_dir/wrangler.production.json"
```

再回读version、绑定、Route和Cron，验证旧URL／对象摘要、MCP详情与列表、新默认／自定义／永久资源、上传、期限编辑和短期测试资源到点拒绝；观察真实scheduled事件及测试资源清理，不把Cron配置存在等同于已执行。没有证据证明本次步骤通过前，不更新发布完成状态。

### 5.4 失败恢复与回滚边界

恢复正式入口失败时保持兼容维护，修复后重新发布同一已核对bundle；不重设T0。**激活后不能直接回滚不认识有效期的旧Worker**：它即使能读加法Schema，也会失去服务端到期约束。回退版本必须保留期限、KV截止及删除语义；否则继续维护，另行审阅恢复方案。代码回滚使用`wrangler rollback <已记录的兼容版本ID>`，不能只凭Schema可读判断兼容。[Worker回滚限制](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

代码回滚不会恢复D1、KV或R2。数据恢复须保持停写，在独立恢复数据库及配置上演练SQL导入，核对资源ID、对象key、迁移记录、原T0与摘要，再制定切换方案。不要把全量SQL导入非空生产库，不删库／重建撤销迁移，也不能恢复到激活前后重新开始30天。D1 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)恢复影响整个数据库，须先核对窗口；SQL与Time Travel均不备份R2，已删除正文没有独立副本就无法随D1恢复。

## 6. 验收和可观测性

`npm run test:deployment` 使用内存 API 和临时目录验证计划无写入、首次创建、分页、重入、部分失败恢复、旧 ID 保护、私有桶校验、凭据脱敏和路径生成。它不证明真实账户权限、云端资源创建、Access 登录、Route 切换或 AE 数据可见性。`deploy --dry-run` 只证明配置可解析和构建包可生成，也不会发布。

每次云端验收至少记录真实 MCP 工具调用、匿名旧／新分享访问、有效及无效上传 Token、文件下载摘要、删除与恢复任务、统计事件及默认时区、Cron 触发和告警状态。本次有效期功能还需记录实际T0及迁移数量、重复激活不变、短期测试资源GET/HEAD/Range到点拒绝和定时清理；旧版验收记录不能替代这些结果。结合 Workers Logs/Metrics、D1/KV/R2/AE 用量观察失败和费用；日志不得包含 Token 或文件正文。

当前生产 Zone 的 Free Website 请求体上限为 100 MB，包含 multipart 开销；Workers Paid 不提高该上限。原型云端 32 MiB、本地 workerd 160 MiB 是不同证据，后者不能证明当前域名能接收 160 MiB。容量配置省略也不会绕过平台限制。见 [Workers 请求限制](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits)。

2026-10-11 用户补齐 KV 权限后，真实初始化与回读已通过：

- D1 `cf-content-share`、KV `cf-content-share-mappings`、R2 `cf-content-share` 已创建；再次执行 `--apply` 全部返回 `reuse`，资源 ID 不变。
- R2 回读确认 Standard、`r2.dev` 禁用且无自定义域名。正式 D1 应用 `0001_resources.sql`、`0002_files.sql` 后，再次迁移显示无待执行项；初始化时 SQL 回读确认两项迁移、资源数为 0，已发布／预留／清理字节均为 0；后续验收保留删除墓碑与操作历史。
- `deployment.local.json` 与生成的 `wrangler.cloud.json` 均为 `0600` 且被 Git 忽略；包含实际资源绑定的 `deploy --dry-run` 退出 0。AE binding 的 dataset 为 `cf_content_share`；部署后真实访问已产生事件，五类统计查询和样本分页均已通过云端验收。
- 现有 Access 应用仍为 `share.example.com/mcp`，audience 与配置一致；主 Route 已切换到 `cf-content-share`，旧测试链接 Route 已移除；灰云 CNAME 仍指向 `edge.example.net`。

最初 KV 读取的 HTTP 401 / 10000 已解除。正式 Worker 已发布，`ANALYTICS_API_TOKEN` 已按用户要求配置；主 Route、两个旧链接 Route、Secret 名称与五分钟 Cron 已通过 API 回读。发布版本、实际验收结果及剩余边界见[正式服务云端验收](research/2026-10-11-formal-cloud-acceptance.md)。

CLI API 契约依据：[D1 数据库 API](https://developers.cloudflare.com/api/resources/d1/subresources/database/)、[KV namespace API](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/)、[R2 桶列表及 cursor](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/list/)、[R2 桶属性和 storage_class](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/get/)、[R2 managed domain](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/subresources/managed/methods/list/)、[R2 custom domains](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/subresources/custom/methods/list/)。

## 7. Codex Desktop 连接

连接名称为 `cf-content-share`，URL 为 `https://share.example.com/mcp`。本机已用 `codex mcp logout cf-content-share-compat` 清除旧凭据、remove 删除旧定义，再以新名称 add 并完成 OAuth 登录；Desktop 重启 MCP 后已加载 `mcp__cf_content_share`。

新安装请换成自己的域名，例如 `codex mcp add cf-content-share --url https://share.example.com/mcp`；OAuth 需要时使用 `codex mcp login cf-content-share`。CLI 与 Desktop 共用配置；更改后在 Desktop Settings → MCP servers 点击 Restart，再调用 describe 查看目录。[官方 MCP 配置说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

2026-10-11 退役后验证：云端 Worker/D1/R2/KV/Route 列表只保留正式资源，没有原型资源；两个旧链接均为 404。Desktop 新名称下 describe 返回 14 项 operation，invoke(storage.get) 返回全零容量，invoke(resource.list) 成功返回空列表。删除原型及更名测试夹具后完整检查 70 项通过、0 失败。正式服务业务代码及部署版本未改变。
