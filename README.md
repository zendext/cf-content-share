# cf-content-share

基于 Cloudflare 的轻量内容分享服务，支持网址、图片和其他文件，通过 MCP 等 Agent 接口管理内容并查询访问统计。

项目面向单人自部署、自用。以自动生成的短 URL 作为分享入口，持有链接即可访问，不提供自建管理 GUI。

首版需求与技术方案已确认。根目录已开始实现正式 Rust/Wasm 服务：第一批短链管理、D1 原子登记、KV 回源与失效、分页搜索和 Cron 恢复已通过本地 workerd 测试，尚未部署。文件上传、容量与访问统计仍待接入正式模型。完整方案采用 Rust/Wasm Worker、D1、KV、R2 和 Analytics Engine。

原型已部署到 `share.example.com`。Codex 已完成真实 Managed OAuth 登录，Desktop 当前聊天已验证工具调用、上传会话、32 MiB 云端流式上传及匿名下载摘要校验；上传会话撤销生效。OAuth 自动刷新、Hermes 与云端中断恢复仍待验证。域名当前为 Free Website 套餐，平台单请求体上限为 100 MB，Workers Paid 不提高这一限制。

当前入口采用 Worker Route＋灰云 CNAME 到 `edge.example.net`，切换后已重新验证 OAuth、MCP 和固定优选 IP 的上传回读；DNS 记录独立于 Wrangler 的 Route 配置维护。

- [产品需求](docs/requirements/product.md)：产品范围、资源模型、统计与删除规则及验收标准。
- [技术设计](docs/design/technical.md)：组件职责、认证、MCP 接口、上传、缓存、失败恢复、部署与验证安排。
- [正式服务实现进度](docs/plan/implementation.md)：当前接口、验证证据、后续批次与上线边界。
- [兼容性原型](prototypes/compat/README.md)：构建、测试、原型边界与云端配置缺项。
- [兼容性实验记录](docs/research/2026-10-11-rust-wasm-compatibility.md)：可复现实测、失败结果及未验证项。

## 正式工程本地开发

需要 Rust、`wasm32-unknown-unknown` target、`worker-build 0.8.7` 和 Node.js。依赖版本由 Cargo／npm lockfile 固定。

```sh
export PATH="$HOME/.cargo/bin:$PATH"
npm ci
npm run check
npm run db:migrate:local
npm run dev
```

`npm run check` 构建 Wasm，通过官方 MCP SDK 在 workerd 中执行 16 项端到端测试；不连接真实 Access，也不使用云端数据。`npm run dry-run` 检查本地配置与发布包。

`wrangler.local.jsonc` 仅供本地使用，资源 ID 是占位值，没有生产 Route。通过 `.dev.vars` 设置自己的 `ACCESS_ISSUER`、`ACCESS_AUD` 可配置本地 JWT 校验；没有跳过认证的开关，MCP 请求仍需有效 Access 断言。自动测试使用独立测试密钥和本地 D1/KV。

本地迁移可重复执行；正式云端资源初始化和部署配置属于后续批次。线上原型的构建与发布仍在 `prototypes/compat/` 中进行。
