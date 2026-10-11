# cf-content-share

基于 Cloudflare 的轻量内容分享服务，支持网址、图片和其他文件，通过 MCP 等 Agent 接口管理内容并查询访问统计。

项目面向单人自部署、自用。以自动生成的短 URL 作为分享入口，持有链接即可访问，不提供自建管理 GUI。

首版需求与技术方案已确认，当前仓库仅包含设计文档，尚未实现服务功能。计划采用 Rust/Wasm Worker、D1、KV、R2 和 Analytics Engine；Rust/MCP/OAuth 及流式上传仍需实际联调验证。

- [产品需求](docs/requirements/product.md)：产品范围、资源模型、统计与删除规则及验收标准。
- [技术设计](docs/design/technical.md)：组件职责、认证、MCP 接口、上传、缓存、失败恢复、部署与验证安排。
