# Rust/Wasm、MCP、Access JWT 与流式 R2 兼容性实验

- 状态：本地验证通过；真实 Cloudflare/OAuth 联调受环境阻塞，整体结论仍为部分验证。
- 日期：2026-10-11。
- 执行者：Codex。
- 基线：`18a98d6a2ad0f3ce52f022f9c3c1a322a9b5c23d`，实验实现位于当前工作区。
- 设计：[技术设计 11.1](../design/technical.md#111-先完成最小兼容性原型)。
- 产物：[原型代码及运行说明](../../prototypes/compat/README.md)、[集成测试](../../prototypes/compat/tests/compat.test.mjs)。

## 问题与判定标准

验证单个 Rust/Wasm Worker 能否接受标准 MCP 客户端的发现与调用、通过平台 Web Crypto 验证 Access JWT、使用 D1 管理 24 小时应用 Token，并将 multipart 文件持续写入 R2，使用原生 SHA-256 校验。

成功标准包括真实执行 Wasm、官方 MCP SDK 调用成功、错误认证被拒绝、大小／摘要错误不发布，以及文件规模显著大于 Wasm 内存。Cloudflare Access 的 OAuth 发现、注册、登录、刷新和 Codex/Hermes 互操作必须另有真实环境证据。

## 环境与输入

| 项目 | 版本／输入 |
| --- | --- |
| 系统 | Linux x86_64 |
| Rust | rustc 1.93.0，`wasm32-unknown-unknown` |
| Node / npm | 22.21.1 / 10.9.4 |
| workers-rs / worker-build | 0.8.7 / 0.8.7 |
| multipart | multer 3.1.0，默认功能，无 Tokio HTTP server |
| Wrangler | 4.149.0 |
| Miniflare / workerd | 5.20261006.1-alpha / 1.20261006.1 |
| 官方 MCP SDK 测试客户端 | `@modelcontextprotocol/sdk` 1.32.1 |
| MCP 协商版本 | 2025-06-18 |
| JWT fixture | 每次测试临时生成 RSA-2048 密钥；RS256；只在测试中替换 JWKS HTTP 返回 |
| 文件 fixture | 空文件、固定短文本、1 MiB 重复字节、160 MiB 的 `0xa5`；摘要由 Node SHA-256 独立计算 |

所有测试输入均为合成数据，不包含真实凭据或私人文件。大文件以 64 KiB 数据块重复生成，客户端与 Rust 均不建立全文件缓冲。Cargo/npm 的实际依赖由各自 lock 文件记录。

## 实现选择与执行方法

- 使用 Rust 无状态 Streamable HTTP 适配层，支持这次原型实际需要的 initialize、ping、tools/list、tools/call、通知和协议错误。没有引入需要原生网络运行时的 MCP HTTP server。
- OAuth 授权服务器仍由 Access 提供。Rust 调用 Web Crypto importKey/verify；JWKS 地址由部署配置决定，不能由 JWT 中的 URL 指定。没有静态管理认证替代方案。
- `ByteStream → multer → FixedLengthStream → R2 put(sha256)`。输入适配器在每块之后让出一次 poll，避免 multer 连续拉取就绪块并累积缓冲。只对 metadata 和 multipart 封装预读设界限。
- D1 登记上传，再写入私有 R2；成功后核对大小、R2 返回的 SHA-256，并更新为 stored。相同操作 ID 的并发请求只有登记成功的请求可写对象。
- Miniflare 使用与 Wrangler 相同的 workerd。D1 和 R2 均为本地实现；RSA 签名、Wasm 验签、SQL、multipart、R2 校验均实际执行，不 mock 业务逻辑。

## 命令与观察

从仓库根目录进入 `prototypes/compat`，依照[运行说明](../../prototypes/compat/README.md#运行与验证)准备工具链后执行：

```sh
npm run check
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
npx wrangler d1 migrations apply cf-content-share-compat --local
```

最终相关代码修改后，`npm run check` 退出码 0：格式检查和 Wasm Clippy 无警告，release Wasm 构建成功，10 组集成测试通过，失败 0。各命令实际证据与声明对应如下：

| 声明／验收范围 | 最新证据 | 结果 |
| --- | --- | --- |
| Wasm 可构建且格式、静态检查通过 | `npm run check` 内的 fmt、Clippy、worker-build | 通过，退出码 0；fmt/Clippy 未单独报告失败数 |
| Access JWT 本地验签和路径分离 | 测试 1：缺失、错误 audience/issuer、过期、未来 nbf、alg=none、未知 kid、篡改签名均拒绝；异源 Origin 拒绝；匿名探针通过 | 通过 |
| MCP 实际发现和调用 | 测试 2：官方 SDK 握手、两个工具、echo、错误参数、未知协议方法、通知 202、GET 405 | 通过 |
| 应用 Token 生命周期 | 测试 3：86400 秒有效期、D1 只保存摘要、多次上传、空文件、重试、参数冲突、撤销、到期、不能作为 MCP 断言 | 通过 |
| 上传校验不误发布 | 测试 4：偏大／偏小声明、错误 SHA-256、截断 multipart；D1 失败且本地 R2 无对象 | 通过 |
| 大文件持续流式处理 | 测试 5：167772160 字节，原生 R2 SHA-256 与独立计算一致 | 通过；最终一次记录 chunks=45311、max_chunk_bytes=4096、wasm_memory_bytes=1310720 |
| 并发和响应丢失 | 测试 6：同 ID 并发只有一个 201；丢弃响应后 operation.get 及重试返回同对象 | 通过 |
| multipart 完整性 | 测试 7：多余 file 部分、文件长度正确但结束分隔符损坏，均不发布 | 通过 |
| 真正 HTTP 连接中断 | 测试 8：等待 D1 登记后中止本地 HTTP fetch；记录变 failed，R2 无对象，公开读取 404 | 通过 |
| 头部缓冲有界 | 测试 9：300 KiB multipart 头部拒绝 | 通过 |
| R2 成功、D1 收尾失败 | 测试 10：SQL trigger 注入失败，响应 500；完整对象保留、D1 pending、公开读取 404、同 ID 重试 409 | 通过；自动恢复仍未实现 |
| Wrangler 可以打包 | deploy dry-run：729.68 KiB，gzip 273.36 KiB；识别 D1/R2 bindings | 通过，退出码 0；未报告失败数；不代表已经部署 |
| Wrangler 本地 HTTP 入口 | dev 监听 127.0.0.1:8791；匿名 /r/probe 返回 200，无凭据 /mcp、POST /upload 返回 401 | 通过；请求检查退出码 0 |
| 本地迁移可执行 | Wrangler local migration：0001_compat.sql 成功 | 通过，退出码 0；未报告失败数 |

chunks 数受本地网络拆包影响，并非固定性能指标。Wasm 线性内存约 1.25 MiB 的结果支持该路径没有全文件进入 Wasm 缓冲；它不测量 workerd/Node 的总 RSS，也不证明云端 CPU 用量或服务限制。

## 负面结果与修正

1. 初次测试启动失败：Wrangler 4.149.0 带入的 Miniflare 5 不再接受旧版顶层配置，兼容转换也不支持自动 modulesRules。依据安装包类型定义改为显式 JS/Wasm 模块清单并调用其 v4 配置转换函数。环境启动后，空 Worker 返回 404，MCP 初始化失败，确认缺失功能可被测试捕获。
2. 构建工具 0.8.7 的 `build/worker/shim.mjs` 是兼容入口，实际包位于 `build/index.js` 与 `index_bg.wasm`；Wrangler 和测试均使用实际输出路径。
3. 头部缓冲回归测试先得到 201，而期望 400：multer 的 metadata 字段上限不限制 MIME 头部。增加独立封装预读预算后，同测试返回 400；未改变文件大小默认不限的规则。
4. 安装 worker-build 的上游锁文件提示 `yoke-derive 0.8.3` 已被 registry 撤回；工具安装成功，最终项目 Clippy/build/test 无警告。该提示属于构建工具的上游锁文件，后续升级应复核。

这是兼容性原型，按测试技能的一次性原型例外先搭建最小工具链及测试框架，再迭代实现和真实运行验证；头部缓冲修正保留了单独的失败→通过回归证据。没有把测试框架启动错误当成功能红灯。

## 云端预检与阻塞

2026-10-11 首次使用现有环境变量对 Cloudflare API 做只读预检，未打印 Token，未读取客户端 OAuth 凭据。以下为权限补齐前的历史结果：

| API 范围 | 实际结果 |
| --- | --- |
| Token verify | active |
| example.com Zone、Workers scripts | 可读取 |
| D1 database list | HTTP 401 / code 10000 Authentication error |
| R2 buckets list | HTTP 403 / code 10000 Authentication error |
| Access organization | HTTP 403 / code 10000 Authentication error |
| Access apps、identity providers | HTTP 403 / code 9999：Access is not enabled |

### 权限补齐后的云端初始化

同日用户补齐 Token 权限并授权初始化后，复查 Token 为 active，Zone、Workers Domains、R2 buckets、D1 database API 均成功；Access organization/apps/IdP 返回的错误统一为 code 9999：`Access is not enabled`。

查找确认没有同名资源后，创建专用资源并更新 Wrangler 账户、D1 ID 和目标 origin。未修改账户里其他 bucket，未创建本原型尚未使用的 KV、Analytics Engine 或 Cron。

```sh
npx wrangler r2 bucket create cf-content-share-compat --storage-class Standard --update-config=false
npx wrangler d1 create cf-content-share-compat --update-config=false
npx wrangler d1 migrations apply cf-content-share-compat --remote
npx wrangler r2 bucket dev-url get cf-content-share-compat
npx wrangler r2 bucket domain list cf-content-share-compat
```

实际结果：R2 Standard bucket `cf-content-share-compat` 创建成功；D1 ID 为 `00000000-0000-0000-0000-000000000001`，平台选择 WNAM；`0001_compat.sql` 远端执行成功。R2 的 `r2.dev` 为 disabled，没有自定义域名。创建与迁移命令退出码均为 0，未报告失败数。

再次执行远端迁移显示无待应用迁移；SQL 回读确认 `upload_sessions`、`uploads` 两张表及迁移登记，业务表均为 0 行。该证据确认资源初始化与迁移，不代表云端 Worker 上传链路已运行。

当时的剩余阻塞是 Zero Trust 团队首次初始化、单人准入邮箱及 Access 应用 issuer/AUD，尚未部署 Worker。随后完成情况见下一节。完整配置与准备清单见[云端联调准备](../../prototypes/compat/README.md#云端联调准备)。

### Zero Trust API 初始化与域名部署

用户指定团队名 `example-team` 并提供准入邮箱后，先确认原组织仍不存在，再调用：

```text
POST /accounts/<account_id>/access/organizations
{"name":"example-team","auth_domain":"example-team.cloudflareaccess.com"}
```

返回 201；GET 回读返回 200，组织名和 auth_domain 一致，`deny_unmatched_requests=false`。此前 GET 返回 `Access is not enabled` 只能证明当时组织未启用，不能据此判断必须由用户手动开户；实际 POST 已证实可以 API 初始化。

IdP 列表初始为空，随后创建 Cloudflare 身份提供方，ID `00000000-0000-0000-0000-000000000001`，`restrict_to_account_members=true`。创建 self-hosted Access 应用 `00000000-0000-0000-0000-000000000001`，domain 为 `share.example.com/mcp`；唯一 allow 策略包含用户指定的一个邮箱。邮箱未写入仓库文档。API 回读核对了 domain、audience、IdP、Managed OAuth 及完整准入规则。

OAuth 配置启用 localhost 和 127.0.0.1 动态注册，Access Token 15 分钟，授权会话 24 小时。部署前查询该域名没有现有 DNS 记录或 Worker 域名绑定，然后执行 Wrangler dry-run 和 deploy，均退出码 0。部署版本为 `00000000-0000-0000-0000-000000000001`，自定义域名 `share.example.com`，workers.dev/预览 URL 均关闭；启动时间报告为 8 ms。

云端 HTTP 实测（Node 22 fetch）：

| 检查 | 结果 |
| --- | --- |
| GET `/r/probe` | 200，返回匿名探针 JSON |
| 无 Token POST `/upload` | 401，Worker 的 UNAUTHORIZED；无 Access OAuth challenge |
| 无 Token POST `/mcp` | 401，Access 的 invalid_token，带 resource_metadata challenge |
| challenge 中 `/.well-known/cloudflare-access-protected-resource/mcp` | 200，resource 正确，授权服务器为 example-team.cloudflareaccess.com |
| 团队 `/.well-known/oauth-authorization-server` | 200，公布 authorization、token、registration、revocation 及 refresh_token / S256 支持 |
| 团队 `/cdn-cgi/access/certs` | 200，2 个 RSA 公钥 |
| 猜测的标准路径 `/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server/mcp` | 404；客户端须沿 challenge 提供的元数据地址发现 |

负面观察：Python 默认请求返回 Cloudflare 1010/browser_signature_banned；单变量更换为 Node fetch 后同一路径成功。Zone browser_check=on，但 UA Rules API 返回 403，不能只凭该设置判定唯一根因；未修改整个 Zone 的防护。Codex/Hermes 的实际 User-Agent 和登录流程仍需验证。

这次 API 初始化未要求套餐选择或支付步骤。当时尚未进行客户端登录、动态注册、浏览器回调或云端上传；后续实际结果见下一节。团队创建与公开发现通过不能替代这些证据。

### Codex Desktop 工具调用与云端上传

2026-10-11，使用本机 Codex CLI 0.162.1 执行 `codex mcp add cf-content-share-compat --url https://share.example.com/mcp`，写入 Desktop/CLI 共用配置。Codex 自动发现 OAuth，发起动态客户端注册、S256 PKCE 授权和 127.0.0.1 回调，最终输出 `Successfully logged in`。未读取或导出 Codex 保存的 OAuth 凭据。Desktop 构建号本次未单独采集，不能用 CLI 版本代替 Desktop 版本。

使用者在 Desktop 重启 MCP 服务后，当前聊天加载 `mcp__cf_content_share_compat`，直接调用真实工具，未使用测试 JWT 或协议模拟客户端替代 Desktop。上传遵守设计边界：MCP 创建应用会话，Node 22 读取本地文件并通过 HTTP 流式上传，文件正文不进入 MCP JSON。

| 检查 | 实际结果 |
| --- | --- |
| `describe` 目录及逐操作 Schema | 4 个操作可发现，Schema 正常 |
| `prototype.echo` 中文文本 | 原样返回，`isError=false` |
| `prototype.echo` 非法参数类型 | `INVALID_ARGUMENTS`，`isError=true` |
| `session.create` | 返回应用 Token，expires_at - created_at = 86400 秒 |
| 同一 Token 上传 59 字节与 32 MiB 文件 | 均为 HTTP 201，state=stored |
| 匿名回读两份文件 | HTTP 200，字节数及 SHA-256 与本地一致 |
| `operation.get` 查询两次成功上传 | 返回对应 resource_id、size_bytes 和 stored |
| 同 operation_id / 相同 metadata 重试 | HTTP 200，返回原 resource_id |
| 同 operation_id / 不同 filename | HTTP 409，IDEMPOTENCY_CONFLICT |
| 错误 SHA-256 | HTTP 422，UPLOAD_STREAM_OR_CHECKSUM_FAILED；MCP 查询为 failed，公开路径 404 |
| `session.revoke` 后使用旧 Token | HTTP 401，UNAUTHORIZED |
| 撤销应用会话后再次调用 MCP echo | 仍成功，符合两类凭据独立的设计 |

32 MiB 文件为 33,554,432 字节，客户端以 64 KiB 块生成本地文件，再用 `fs.createReadStream` 构造固定 Content-Length 的 multipart 请求。云端报告 8194 个 file chunk、最大 chunk 5618 字节、Wasm 线性内存 1,310,720 字节；SHA-256 为 `edeadec8f638055689d5be63b4bcf2654fb64bf91fb6651e9a924f052a9c7db0`。这证明本次云端流式路径及 R2 原生摘要校验可工作，内存数字仅涵盖 Wasm 线性内存，不代表 Worker 总 RSS 或 CPU 用量。

一次性验证程序为 `<private-test-dir>/check.mjs`，非敏感结果为同目录 `results.json`，运行退出码 0，所有断言通过。应用 Token 只写入 0600 的临时文件，测试后已撤销并删除该文件。32 MiB 测试对象及其 D1 记录已按精确 ID 删除，清理后公开 URL 为 404。保留 59 字节测试样例用于人工回读，resource_id 为 `example-resource-id`；其 SHA-256 为 `90ce5cb04387709127206b95b98f667b93a67a302f114d4b17dfe96b00dd3040`。失败上传的非敏感 D1 记录和已撤销会话记录保留为证据。

本轮未等待 15 分钟访问令牌到期，未触发并确认 OAuth refresh_token 流程，也未测试 OAuth 撤销或 Hermes。24 小时应用 Token 到期仍只有此前本地测试证据。Codex 本轮没有遇到 Python 默认 UA 的 1010 问题。

### 费用与平台边界（2026-10-11 核对）

按 Workers Paid 基础费 5 美元/月估算，单人、低流量且各产品都未超过包含额度时，整套可维持约 5 美元/月；这不是费用上限，也不含域名续费和税费。同账户其他项目共同消耗相关额度，不能为每个 bucket 或 Worker 重复计算免费量。已有 Workers Paid 时，本项目无需重复购买基础套餐。

| 服务 | 与本项目相关的包含额度或费用 |
| --- | --- |
| Access / Zero Trust Free | 50 用户免费额度；本项目仅一名管理用户，匿名分享访问不经过 Access |
| Workers Paid | 5 美元/月起；每月 1000 万请求、3000 万 CPU ms；超量分别 0.30 美元/百万请求、0.02 美元/百万 CPU ms |
| D1 Paid 配额 | 每月 250 亿行读取、5000 万行写入、5 GB 存储；超量单独计费 |
| KV Paid 配额 | 每月 1000 万次读取、写入/删除/list 各 100 万次、1 GB 存储；超量单独计费 |
| R2 Standard | 每月 10 GB-month、100 万次 A 类、1000 万次 B 类免费；额外存储 0.015 美元/GB-month，A/B 分别 4.50/0.36 美元每百万次，无互联网出站流量费 |
| Analytics Engine | 官方当前注明尚未收费；公布的 Paid 配额为每月 1000 万写入点、100 万查询，开始计费时须重新核对 |

例如账户 R2 整月存储 100 GB，其他计量均在额度内，则额外存储约 `(100-10)×0.015=1.35` 美元，合计约 6.35 美元/月。R2 按计费单位向上取整；上述整数容量示例未涉及额外操作费。

实际 Zone API 返回 `Free Website`；Workers account-settings 返回 default_usage_model=standard，但订阅读取 API 返回 403，因此本轮没有确认当前账单订阅或剩余额度，也未更改套餐。官方限制中 Free/Pro 的单次 HTTP 请求体为 100 MB，包含 multipart 封装；Workers Paid 不提高此上限。本轮最大云端验证是 32 MiB，本地 160 MiB 成功不能说明当前域名可接收同样大小。超过该限制需要重新设计分片/直传或调整相应平台方案，均不在本轮变更内。

依据：[Workers 价格](https://developers.cloudflare.com/workers/platform/pricing/)、[D1 价格](https://developers.cloudflare.com/d1/platform/pricing/)、[KV 价格](https://developers.cloudflare.com/kv/platform/pricing/)、[R2 价格](https://developers.cloudflare.com/r2/pricing/)、[Analytics Engine 价格](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)、[Cloudflare 官方 Zero Trust 套餐说明](https://www.cloudflare.com/#)、[请求体限制](https://developers.cloudflare.com/workers/platform/limits/)、[Codex MCP 共用配置与 OAuth](https://learn.chatgpt.com/docs/extend/mcp)。

### 优选 IP 接入预检与提交前复测

2026-10-11，本机 DNS 查询 `edge.example.net` 得到 A 记录 `192.0.2.1`，未返回 AAAA。使用下列方式绕过 HTTP 代理，保留原域名的 Host、TLS SNI 及正常证书校验，直接连接该 IP：

```sh
curl --noproxy '*' --resolve share.example.com:443:192.0.2.1 \
  --connect-timeout 8 --max-time 20 -A node -D - https://share.example.com/r/probe
curl --noproxy '*' --resolve share.example.com:443:192.0.2.1 \
  --connect-timeout 8 --max-time 20 -A node -D - \
  -X POST -H 'Content-Type: application/json' --data '{}' https://share.example.com/mcp
```

结果分别为 HTTP 200 匿名探针及 HTTP 401 Access OAuth challenge，两个 curl 退出码均为 0，CF-Ray 的机房后缀均为 LAX。这证明该 IP 在本次网络环境下可以承接原域名的 Worker 和 Access 未登录入口；未比较延迟、吞吐或不同运营商表现，也未通过该固定 IP 单独复测已登录 MCP 和上传。优选域名的 IP 会变化，不能把本次 IP 当作永久配置。

Cloudflare API 回读 `share.example.com` 为 Custom Domain 管理的 proxied AAAA `100::`，`meta.read_only=true`，绑定当前 Worker。它不能直接编辑成 `edge.example.net` 的普通 CNAME；橙云 CNAME 的公开 DNS 也通常返回 Cloudflare 分配的 Anycast 地址，并不保证采用目标域名选出的 IP。保留现有 Custom Domain，在受控客户端或网关 DNS 层选取入口 IP 是本次实测支持的方向。若要求所有公开访客经指定入口，则须另行验证 DNS／域名接入方案，不能简单关闭代理并假定 Worker、Access 和证书仍然有效。本轮没有改动生产 DNS 或域名绑定。

依据：[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)、[Routes 前置条件](https://developers.cloudflare.com/workers/configuration/routing/routes/)、[DNS Proxy status](https://developers.cloudflare.com/dns/proxy-status/)。

提交前再次运行 `PATH="$HOME/.cargo/bin:$PATH" npm run check`，格式、Wasm Clippy、release 构建及 10 组集成测试通过，退出码 0、失败 0。该次本地 160 MiB 上传报告 44415 个 chunk、最大 chunk 4096 字节、Wasm 线性内存 1,310,720 字节。构建输出及本地测试状态由 `.gitignore` 排除，不进入提交。

### Worker Route＋灰云 CNAME 实际切换验证

2026-10-11，用户授权实际切换，关键链路失败时恢复原配置。先将 Custom Domain、DNS、Routes、Access 应用及本地 Wrangler 配置快照保存到忽略目录 `prototypes/compat/.wrangler/route-trial/`，该目录权限 0700，JSON 快照权限 0600；快照包含准入信息，不进入 Git。切换前 Desktop MCP echo 成功，原 Zone 没有 Worker Route。

第一次尝试中，删除 Custom Domain 的 API 成功返回空响应，控制脚本按 JSON 解析导致异常。脚本立即重建原 Custom Domain 并删除临时 Route；恢复后固定优选 IP 的探针返回 200。此失败属于控制脚本响应处理，并非灰云方案失效。修正空成功响应处理后重新执行，得到以下配置：

| 项目 | 切换后状态 |
| --- | --- |
| Custom Domain | 已移除，`workers/domains` 中不再存在 share.example.com |
| Worker Route | `share.example.com/*` → `cf-content-share-compat`；ID `00000000000000000000000000000000`；request_limit_fail_open=false |
| DNS | CNAME `share.example.com` → `edge.example.net`，proxied=false，TTL 60；ID `00000000000000000000000000000000` |
| 优选入口 | 本次 cf-entry A 记录为 `192.0.2.1`，不将其写死在部署配置 |
| Access | 应用 domain、aud、策略、IdP 和 OAuth 配置与切换前快照逐项相等 |
| Worker | 代码版本未变；workers.dev 和预览入口保持关闭 |

Cloudflare 和 Google 的 HTTPS DNS 查询均返回 `share.example.com CNAME edge.example.net` 及目标 A 记录。本机普通 DNS 在切换后仍返回旧 Anycast 地址及递减 TTL，因此固定 IP 的请求采用 curl `--resolve` 或 undici Agent 的 lookup，保留原 Host、TLS SNI 和证书校验，避免将旧 DNS 缓存误认为优选链路证据。

| 验证 | 实际结果 |
| --- | --- |
| 优选 IP：匿名探针 | 200 |
| 优选 IP：无 Token MCP | Access 401，含正确 OAuth resource_metadata challenge |
| 优选 IP：OAuth 资源发现 | 200，resource 与团队地址正确 |
| 优选 IP：无 Token 上传 | Worker 401，未误进入 OAuth 页面 |
| 切换后重新执行 `codex mcp login cf-content-share-compat` | 新的 OAuth 授权及本机回调成功，CLI 输出 Successfully logged in |
| 新起 Codex app-server 进程，读取刚保存的 OAuth 凭据 | `mcpServerStatus/list` 返回 authStatus=oAuth，发现 describe/invoke 两个工具，无 error；未导出客户端 OAuth 凭据 |
| 当前 Desktop MCP | echo、session.create、operation.get、session.revoke 均成功 |
| 优选 IP：同一应用 Token 两次上传 | 59 字节及 32 MiB 均返回 201/stored；固定 IP 匿名下载大小和 SHA-256 均一致 |
| 优选 IP：重试与冲突 | 相同操作返回 200/原 resource_id；不同 filename 返回 409 |
| 优选 IP：错误摘要 | 422；Desktop 查询上传状态为 failed |
| 优选 IP：撤销应用会话后再次上传 | 401/UNAUTHORIZED |

32 MiB 上传报告 8195 个 file chunk、最大 chunk 5774 字节、Wasm 线性内存 1,310,720 字节。SHA-256 为 `edeadec8f638055689d5be63b4bcf2654fb64bf91fb6651e9a924f052a9c7db0`。测试程序 `route-trial/check.mjs` 及非敏感结果 `results.json` 保存在本地忽略目录，退出码 0，全部断言通过。应用 Token 已撤销，0600 临时 Token 文件已删除。32 MiB R2 对象及精确匹配的 D1 记录已清理；保留 59 字节样例及失败记录。新样例 resource_id 为 `example-resource-id`。

最终本机 DNS 缓存刷新后，`dns.lookup` 返回 `192.0.2.1`；未固定 IP 的 Node fetch 探针与小样例下载均为 200，已清理大文件及摘要失败资源为 404。此后再启动一个全新 Codex app-server 进程，使用正常系统 DNS 和刚登录保存的凭据，认证工具发现再次通过。云端 API 最终回读确认 CNAME/Route 正确、Custom Domain 不存在、workers.dev/preview 设置与原快照一致。上述验证退出码均为 0。

结论：该账户当前的 Worker Route＋灰云 CNAME 组合通过本轮 OAuth、MCP 和云端上传检查，保留切换后的配置。Wrangler 已改为 Route 格式，DNS CNAME 独立维护；`wrangler deploy --dry-run` 构建通过，包大小 729.68 KiB、gzip 273.36 KiB，退出码 0；配置解析、文档链接和 diff 检查通过。此前“必须只在客户端优选”的建议过于保守，不能用官方文档的推荐配置代替实际互操作结果。官方 Route 文档仍要求 proxied DNS，因此这里只承诺本轮实测结果，不推断平台长期兼容性、证书续期或其他账户行为。OAuth 自动刷新、撤销以及 Hermes 仍未在本轮验证。

回滚顺序：删除这条实验 CNAME，通过 `PUT /accounts/<account>/workers/domains` 重新绑定 `share.example.com` 到当前 Worker（enabled=true、previews_enabled=false），确认平台生成 proxied AAAA `100::`，再删除实验 Route，并将 Wrangler routes 恢复为 `{"pattern":"share.example.com","custom_domain":true}`。复测匿名探针、Access 未授权挑战及已登录 MCP。现有本地 `route-trial/control.py restore` 可恢复云端；本地配置原件为 `wrangler.before.jsonc`。不要将快照整体上传仓库。

## 限制与结论

本地证据支持继续采用 Rust/Wasm：官方 SDK 可以通过这个适配层调用工具，Web Crypto 的 RS256 验签可执行，multer 与 R2 固定长度流、原生校验可以组成有界内存上传链路。

云端证据进一步支持当前实现：Codex 完成真实 Managed OAuth 注册和登录，Desktop 工具调用、独立应用会话、云端 R2 流式上传与摘要校验通过；匿名读取和应用 Token 上传均未被 `/mcp` 的 Access 策略阻断。仍未验证 OAuth 自动刷新／撤销、Hermes、云端请求大小临界值、R2 中断与进程终止恢复，不能称为全部兼容性验收通过。

完整服务仍须实现正式资源 ID、容量原子预留、R2 成功/D1 失败的收尾、进程被终止后的恢复、同 ID 失败重传、KV、统计和 Cron。本次没有运行 Analytics Engine，也没有修改已确认产品要求。当前无需切换语言或认证方案，但整体兼容性结论须等云端证据补齐。

Documentation impact:
- Updated：根 README 与技术设计同步当前原型状态；原型 README 保存运行契约；本记录保存实验及阻塞。
- Verification：本地 Markdown 链接、最终 diff、代码与测试范围对应检查；运行证据如上。

## 官方依据

- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)：采用允许的 JSON 响应模式，不宣称必须实现 SSE 推送。
- [Access Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)：Access 处理 OAuth opaque token，origin 验证签名断言。
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)：put 的 SHA-256 校验及返回 checksum 字段。
- [Rust Workers](https://developers.cloudflare.com/workers/languages/rust/)：workers-rs / worker-build 构建与 Wrangler 平台入口。
