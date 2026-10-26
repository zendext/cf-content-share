# cf-content-share

[English](README.md) · 简体中文

单人自部署的 Cloudflare 内容分享服务。把网址变成短链，把图片和文件上传后生成分享链接，通过 MCP 让 Agent 管理内容并查询访问统计。持有分享链接即可访问，管理操作需要认证；不提供独立管理网页。

新资源默认从首次发布起保留 30 天。创建时可指定自定义时长或永久保存，也可以在到期前修改截止时间。到期后停止新的服务端访问并安排清理；已下载或被浏览器缓存的副本无法收回。

## 基础设施

| 服务 | 用途 |
| --- | --- |
| Workers（Rust / Wasm） | MCP、短链跳转、流式上传和下载 |
| D1 | 资源元数据、操作和容量计数 |
| Workers KV | 公开资源映射 |
| R2（Standard 私有桶） | 图片和文件正文 |
| Analytics Engine | 访问事件与最近 30 天的统计查询 |
| Access + Managed OAuth | 管理员登录和 MCP 客户端授权 |
| Cache API / Cron Triggers | 正文缓存／每五分钟恢复操作与清理 |
| DNS + Worker Route | 分享域名接入 |

## 让 Agent 部署

克隆仓库后，将下面的提示词交给有终端和网络访问能力的 Agent。替换占位信息，提前把 API Token 保存到仓库外权限为 `0600` 的文件。

```text
请按照本仓库 docs/zh-CN/deployment.md 安装并部署 cf-content-share。

Cloudflare account ID：<账户 ID>
分享域名：<share.example.com>；所属 Zone：<example.com>
管理员邮箱：<本人邮箱>
Zero Trust 团队：<已有团队名；没有则填写希望创建的名称>
Cloudflare API Token 文件：<仓库外的绝对路径，权限 0600>

授权你安装所需工具、创建本项目缺少的资源、配置专用 DNS、Access 和
Managed OAuth，执行迁移、设置统计 Secret 并部署 Worker。
先检查现有资源并复用匹配项，不覆盖其他服务、不放宽准入策略、不删除已有数据。
若另行提供了 Account Analytics Read Token，用它作为统计凭据；
否则将部署 Token 保存为 ANALYTICS_API_TOKEN。
Token 不得出现在聊天、命令参数、日志或 Git 文件中。

连接我的 MCP 客户端，安装分享 Skill，验证登录、短链、上传下载和统计。
浏览器登录由我完成。缺权限或需要开通服务时报告具体缺项，
不要扩大权限或购买套餐。最后报告通过项和未验证项。
```

Agent 组合使用初始化脚本、Cloudflare API 和 Wrangler；这不是一键安装程序。需要 Node.js 24.12+、rustup、已接入 Cloudflare 的域名及上表服务的使用权限。创建 Token、必要的服务开通和浏览器登录仍需用户完成。权限、手动命令和升级步骤见[部署指南](docs/zh-CN/deployment.md)。

## 安装 Agent Skill

将整个 [`skills/cf-content-share`](skills/cf-content-share/SKILL.zh-CN.md) 目录（含 `scripts/`）复制到 `~/.agents/skills/cf-content-share`。替换已有安装前先核对。Skill 需要 Python 3.12+ 和已认证的 MCP 连接；先按 Skill 检查解释器能力。[上传脚本](skills/cf-content-share/scripts/upload.py) 只用标准库，无需 npm、pip 或虚拟环境。

示例请求：“用 $cf-content-share 分享这个 PDF，标题为‘会议资料’，保留七天。”Agent 发现当前上传契约、保存操作、经 HTTP 上传，并通过 MCP 查询权威结果。安装 Skill 不会上传文件。更新时同步 Skill 和脚本；兼容的业务 Schema 变化由服务发现承载。

## 本地开发

`rust-toolchain.toml` 固定 Rust、Wasm target、rustfmt、Clippy 和 rust-analyzer。使用 Node.js 24.12+ 和 Python 3.12+；CI 使用 Node.js 24.21.0 和 Python 3.12。

```sh
python -c "import sys, ssl, hashlib, http.client; assert sys.version_info >= (3, 12)"
npm ci
cargo install worker-build --version 0.8.7 --locked
npm run db:migrate:local
npm run dev
```

`wrangler.local.jsonc` 使用占位资源，不含生产 Route。本地 MCP 仍验证 Access JWT。测试使用独立密钥和本地 workerd，不需要云端凭据。

| 命令 | 用途 |
| --- | --- |
| `npm run format` | Biome 格式化、import 整理及安全修复，然后格式化 Rust |
| `npm run lint` | 检查 Biome、Rust 格式及 Wasm Clippy，警告也会失败 |
| `npm run check:types` | 严格检查 Node 与 workerd 两套 TypeScript 环境 |
| `npm run check` | lint、类型检查、Wasm 构建及全部测试 |
| `npm run dry-run` | 验证本地部署包，不发布服务 |

平台开发脚本与夹具使用 `.mts`，由 Node 原生类型擦除执行。生成的 JavaScript 和依赖不纳入 Git；源码策略测试拒绝新增维护的 JavaScript 文件。独立上传脚本使用 Python 标准库，`npm run check:upload` 编译检查并执行 unittest；上传客户端 CI 在 Linux x86_64/arm64、macOS arm64 和 Windows x86_64 上运行。GitHub Actions 在 PR 和 `main` push 时执行同样的检查及本地 dry-run。VS Code 配置支持 Biome 和 rust-analyzer，其他编辑器可使用相同工具。

## 文档

- [使用方式与 MCP 操作](docs/zh-CN/usage.md)
- [部署与升级](docs/zh-CN/deployment.md)
- [架构与一致性](docs/zh-CN/architecture.md)
- [文件、OAuth 上传与恢复](docs/zh-CN/files.md)
- [访问统计](docs/zh-CN/analytics.md)

所有文档均有对应英文版。中文为权威来源，修改时同步两种语言。

## 许可证

Copyright 2026 cf-content-share contributors。采用 [Apache-2.0](LICENSE) 许可证。
