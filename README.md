# cf-content-share

基于 Cloudflare 的轻量内容分享服务，支持网址、图片和其他文件，通过 MCP 等 Agent 接口管理内容并查询访问统计。

项目面向单人自部署、自用。以自动生成的短 URL 作为分享入口，持有链接即可访问，不提供自建管理 GUI。

首版需求与技术方案已确认。根目录已实现正式 Rust/Wasm 服务：短链与文件管理、流式上传、容量预留、KV／正文缓存、Cron 恢复、访问统计查询和可重复初始化 CLI。正式 Worker 已部署到 `share.example.com`，本地 workerd 和云端验收范围见下方文档。完整方案采用 Rust/Wasm Worker、D1、KV、R2 和 Analytics Engine。

正式服务已通过 Desktop MCP 工具调用、Managed OAuth 登录与刷新、32 MiB 流式上传及下载摘要校验；详细结果见[正式服务云端验收](docs/research/2026-10-11-formal-cloud-acceptance.md)。两个原型测试链接通过更具体的 Route 保留，原型 D1/R2 保持独立。域名仍使用灰云 CNAME → `edge.example.net`；当前 Free Website 套餐单请求体上限为 100 MB，Workers Paid 不提高这一限制。

当前入口采用 Worker Route＋灰云 CNAME 到 `edge.example.net`，正式服务沿用已验证的优选入口；DNS 记录独立于 Wrangler 的 Route 配置维护。

- [产品需求](docs/requirements/product.md)：产品范围、资源模型、统计与删除规则及验收标准。
- [技术设计](docs/design/technical.md)：组件职责、认证、MCP 接口、上传、缓存、失败恢复、部署与验证安排。
- [文件与恢复](docs/files.md)：上传会话、容量、重传、对象防覆盖和缓存。
- [访问统计](docs/analytics.md)：采集字段、加权查询、时区与样本分页。
- [部署与升级](docs/deployment.md)：初始化 CLI、Access、Secrets、迁移与发布。
- [正式服务实现进度](docs/plan/implementation.md)：当前接口、验证证据、后续批次与上线边界。
- [兼容性原型](prototypes/compat/README.md)：构建、测试、原型边界与云端配置缺项。
- [兼容性实验记录](docs/research/2026-10-11-rust-wasm-compatibility.md)：可复现实测、失败结果及未验证项。

## 正式工程本地开发

需要 Rust、`wasm32-unknown-unknown` target、`worker-build 0.8.7` 和 Node.js。依赖版本由 Cargo／npm lockfile 固定。

```sh
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$PWD/target"
npm ci
npm run check
npm run db:migrate:local
npm run dev
```

`npm run check` 构建 Wasm，通过官方 MCP SDK 在 workerd 中执行端到端测试及初始化回归；不连接真实 Access，也不使用云端数据。`npm run dry-run` 检查本地配置与发布包。

`wrangler.local.jsonc` 仅供本地使用，资源 ID 是占位值，没有生产 Route。通过 `.dev.vars` 设置自己的 `ACCESS_ISSUER`、`ACCESS_AUD` 可配置本地 JWT 校验；没有跳过认证的开关，MCP 请求仍需有效 Access 断言。自动测试使用独立测试密钥和本地 D1/KV。

本地迁移可重复执行。`npm run init:cloud -- --config deployment.local.json` 默认只读预览，显式 `--apply` 才创建缺失的正式 D1/KV/R2 资源和生成生产配置，具体见[部署与升级](docs/deployment.md)。统计 SQL 依赖真实 Analytics Engine 和 Worker Secret，本地开发绑定不会提供可查询的真实访问统计。线上原型的构建与发布仍在 `prototypes/compat/` 中进行。
