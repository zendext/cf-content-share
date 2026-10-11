# Rust/Wasm 最小兼容性原型

本目录用于验证[技术设计 11.1](../../docs/design/technical.md#111-先完成最小兼容性原型)中的 MCP、认证及流式上传链路。全部业务代码在 Rust/Wasm 执行；JavaScript 只用于 worker-build 生成的平台入口和测试客户端。资源名中的 `compat` 是 compatibility 的缩写，表示兼容性原型专用资源。

## 运行与验证

需要 Rust 1.93.0 或兼容工具链、Node.js 22。先安装 Wasm target 和与 worker crate 同版本的构建工具：

```sh
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
export PATH="$HOME/.cargo/bin:$PATH"
cd prototypes/compat
npm ci
npm run check
```

`check` 依次运行格式检查、Wasm Clippy、release 构建和 10 组集成测试。测试自动创建临时 workerd、D1、R2；在进程内生成 RSA 密钥，仅在外部 JWKS HTTP 边界提供测试公钥，不跳过 Worker 验签、不调用真实 Cloudflare API。单独复测使用 `node --test tests/compat.test.mjs`，须先构建最新代码。

测试包括一个 160 MiB 流式请求，客户端仅复用 64 KiB 数据块；测试数据由 Miniflare 临时存储并在退出时释放。其本地成功不代表实际域名允许同样大小的请求。

检查发布包但不部署：

```sh
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

需要手动查看本地入口时：

```sh
npx wrangler d1 migrations apply cf-content-share-compat --local
npm run dev
curl http://localhost:8787/r/probe
```

仓库配置已绑定真实 Access 应用；本地 Wrangler 不经过 Access 边缘层，手动访问 `/mcp` 而未携带有效断言仍返回 401。测试套件自身负责提供有效测试断言，没有可部署的静态管理 Token 或认证旁路。

## 原型契约

| 路径／能力 | 当前实现 |
| --- | --- |
| `/mcp` | Rust 编写的无状态 Streamable HTTP 适配层，协商 `2025-06-18`，POST 返回 JSON；通知返回 202，GET/DELETE 返回 405；校验 Origin、协议版本和请求体上限 |
| `describe` / `invoke` | 仅列出这两个工具；目录、参数校验与枚举分发对应；返回 `structuredContent` 及等价文本；业务错误使用 `isError` |
| `prototype.echo` | 接受 `{ "message": "..." }`，返回相同文本，验证工具调用 |
| `session.create` | 接受 `{}`；生成 256 bit 随机 Token，D1 只保存 SHA-256 摘要；固定有效 86400 秒；响应含 Token 和上传说明 |
| `session.revoke` | 接受 `{ "session_id": "..." }`；D1 撤销，新上传逐次查询 D1 |
| `operation.get` | 接受 `{ "operation_id": "..." }`；读取上传的 `pending` / `stored` / `failed` 状态 |
| `/upload` | Bearer 应用 Token；multipart 先 metadata 后 file；Rust `multer` 解析，`FixedLengthStream` 接 R2 `put().sha256()`，成功后复核大小及返回摘要 |
| `/r/<resource_id>` | 只读取 D1 中 `stored` 的对象，用于字节回读；统一附件响应，`no-store` |
| `/r/probe` | 无认证探针，用于检查分享路径未被 Access 覆盖 |

`metadata` 必须包含 `operation_id`、`filename`、`content_type`、`size_bytes`、小写十六进制 `sha256`，当前不接受其他字段。文件内容只传 HTTP，不进入 MCP JSON。metadata 最大 16 KiB；multipart 封装预读预算为 256 KiB，防止无限头部缓冲，预算不适用于已进入流式处理的文件正文。可选 `MAX_FILE_BYTES` 限制声明大小，默认不设文件大小上限。

同操作 ID 和相同元数据在成功后重试返回原对象，不覆盖文件；参数不同返回 409；其他同 ID 执行请求返回 409。R2 使用 create-only 条件，校验失败不发布，失败清理无法完成时保留 pending。持久化成功后丢失响应，可用 `operation.get` 找回结果。

Worker 只接受 `Cf-Access-Jwt-Assertion`，校验 RS256、签名、issuer、audience、exp、nbf 和 sub；公钥只从配置的 Cloudflare Access issuer 拉取。OAuth access token 是由 Access 接收的 opaque token，不能直接当 JWT 或应用上传 Token 使用。JWKS 暂时逐请求拉取，尚未优化缓存。

## 云端联调准备

目标域名：`share.example.com`。2026-10-11 补齐 Token 权限后，已用环境中的 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 创建并回读下列云端资源，实际绑定已写入 `wrangler.jsonc`。R2/D1 读写权限已实测通过。随后通过 API 创建了 `example-team` Zero Trust 团队、Cloudflare 身份提供方和 MCP Access 应用，原型已部署。Codex 已完成真实 OAuth 登录及 Desktop 工具调用，自动刷新与 Hermes 尚待验证。

| 资源 | 实际配置与状态 |
| --- | --- |
| R2 | `cf-content-share-compat`，Standard；`r2.dev` 关闭，无自定义域名，绑定 `FILES` |
| D1 | `cf-content-share-compat`，ID `00000000-0000-0000-0000-000000000001`，平台选择 WNAM，绑定 `DB` |
| D1 迁移 | `0001_compat.sql` 已远端执行，包含 `upload_sessions`、`uploads`；重复执行无待应用迁移 |
| Zero Trust | `example-team`，团队地址 `example-team.cloudflareaccess.com`，API 创建并回读成功 |
| 身份提供方 | Cloudflare，限制为当前账户成员；MCP Access 策略进一步限定为使用者指定的单个邮箱 |
| Access 应用 | `00000000-0000-0000-0000-000000000001`，仅保护 `share.example.com/mcp`，启用 Managed OAuth |
| OAuth | 支持 localhost/127.0.0.1 动态客户端注册；Access Token 15 分钟、授权会话 24 小时 |
| Worker | `cf-content-share-compat`，版本 `00000000-0000-0000-0000-000000000001` |
| 域名配置 | `https://share.example.com` 已绑定；workers.dev 和预览 URL 关闭 |

新客户端的接入步骤（本机 Codex 已完成）：

1. 在支持 OAuth 的 MCP 客户端中添加 Streamable HTTP 地址 `https://share.example.com/mcp`。
2. 从客户端发起登录／授权，在打开的 Cloudflare 登录页面使用已指定邮箱的账号，完成该账号要求的登录或 MFA。
3. 完成页面授权，等待跳回客户端。调用 `describe` 后调用 `invoke`，参数为 `{"operation":"prototype.echo","arguments":{"message":"hello"}}`。
4. 在 Codex、Hermes 分别验证首次登录和后续刷新，记录实际客户端版本与结果。浏览器登录不能由 API 创建团队替代。

团队和身份提供方无需再次手动创建。API 创建组织返回 201，应用创建、策略回读和部署均成功，本次流程没有要求手动选择套餐或填写付款信息。客户端登录结果须单独验证。

本机使用 `codex mcp add cf-content-share-compat --url https://share.example.com/mcp` 写入共用配置并完成 OAuth，CLI 版本为 0.162.1。Desktop 重启该 MCP 服务后，当前聊天直接调用 `describe`、`invoke` 成功。通过 MCP 创建的同一上传 Token 完成 59 字节和 32 MiB 云端上传，匿名回读的大小和 SHA-256 均一致；32 MiB 上传报告 Wasm 线性内存 1,310,720 字节。重复操作返回原资源，冲突返回 409，错误摘要返回 422 且资源不可公开读取；通过 MCP 撤销会话后，旧 Token 返回 401。只保存应用 Token 到权限 0600 的临时文件，未提取 Codex 私有 OAuth 凭据；测试后已撤销并移除该临时 Token。

已验证：Node fetch 访问 `/r/probe` 为 200，未认证 `/mcp` 为 Access 401，无应用 Token 的 `/upload` 为 Worker 401。OAuth 发现应沿 401 的 `WWW-Authenticate.resource_metadata` 地址继续：实际为 `/.well-known/cloudflare-access-protected-resource/mcp`，该路径与团队的授权服务器元数据均返回 200。不要假定服务提供 `/.well-known/oauth-protected-resource/mcp`，此路径实测为 404。

Python 默认 User-Agent 请求实测被 Cloudflare 边缘返回 1010；Node fetch 正常。Zone 的 Browser Integrity Check 当前开启，UA Rules API 无读取权限，尚未将原因唯一定位到某条规则。保留原有 Zone 安全设置，实际客户端若遇到 1010 需继续做针对该子域名的排查。

完整服务后续还需要 KV namespace/绑定、Analytics Engine dataset/查询凭据、5 分钟 Cron 配置，以及正式数据库迁移。KV 用于公开资源映射和状态缓存；当前原型直接读 D1，未使用 KV。Cache API 与 Cron 不需要另建存储实例。以上尚不属于本原型已验证能力。

Token 通过现有环境或本地秘密文件提供，不写入 Git 或聊天。只读 API 成功仅证明可读，不代表写入权限已通过验证；实际初始化仍需检查每步 API 返回值。

权限依据：[API Token 权限表](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)、[Workers 权限](https://developers.cloudflare.com/workers/authorization/workers/)、[Custom Domain API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/)。认证依据：[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)。

## 明确边界

这不是首版服务：原型资源 ID 是随机 Token 格式；尚无正式 12 位 ID、资源管理、session.list、容量预留、KV、缓存、统计、Cron 和恢复状态机；下载仅用于回读验证。`stored` 表示原型已完成 R2 校验及 D1 登记，不表示产品的完整发布流程。

R2 成功但 D1 失败时可能保留 pending 和完整对象，尚不能自动收尾；失败操作复用同 ID 也暂不支持恢复。云端请求大小临界值、R2 中断、进程终止恢复、Managed OAuth 自动刷新／撤销和 Hermes 兼容性仍须实测。OAuth 与应用上传会话的撤销相互独立，不能用应用 Token 撤销通过来证明 OAuth 撤销通过。完整证据与费用边界见[实验记录](../../docs/research/2026-10-11-rust-wasm-compatibility.md)。
