# cf-content-share

基于 Cloudflare 的轻量内容分享服务，支持网址、图片和其他文件，通过 MCP 等 Agent 接口管理内容并查询访问统计。

项目面向单人自部署、自用。以自动生成的短 URL 作为分享入口，持有链接即可访问，不提供自建管理 GUI。

首版需求与技术方案已确认。仓库已有独立的 Rust/Wasm 最小兼容性原型，本地 workerd 已验证 MCP、Access JWT 验签、D1 上传会话及流式 R2 上传；完整服务尚未实现。首版计划采用 Rust/Wasm Worker、D1、KV、R2 和 Analytics Engine。

原型已部署到 `share.example.com`。Codex 已完成真实 Managed OAuth 登录，Desktop 当前聊天已验证工具调用、上传会话、32 MiB 云端流式上传及匿名下载摘要校验；上传会话撤销生效。OAuth 自动刷新、Hermes 与云端中断恢复仍待验证。域名当前为 Free Website 套餐，平台单请求体上限为 100 MB，Workers Paid 不提高这一限制。

- [产品需求](docs/requirements/product.md)：产品范围、资源模型、统计与删除规则及验收标准。
- [技术设计](docs/design/technical.md)：组件职责、认证、MCP 接口、上传、缓存、失败恢复、部署与验证安排。
- [兼容性原型](prototypes/compat/README.md)：构建、测试、原型边界与云端配置缺项。
- [兼容性实验记录](docs/research/2026-10-11-rust-wasm-compatibility.md)：可复现实测、失败结果及未验证项。
