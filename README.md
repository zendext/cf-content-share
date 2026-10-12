# cf-content-share

单人自部署的内容分享服务：把网址变成短链，把图片和文件上传后生成分享链接，通过 MCP 让 Agent 管理内容、搜索资源和查询访问统计。持有链接即可访问；管理操作需要登录，不提供独立管理网页。

新资源默认从首次发布起保留 30 天，创建时可自定义时长或设为永久；未到期前可以调整截止时间，分享地址不变。到期后服务端拒绝新请求并异步清理，浏览器已缓存的副本不会被收回。

资源有效期和 KV 24 小时兜底已部署并激活，本轮完整本地回归及云端验收已完成，见[本次云端记录](docs/research/2026-10-12-expiration-cloud-acceptance.md)。已有安装升级必须按[部署与升级](docs/deployment.md#5-正式版本升级)固定一次旧资源计时起点，不能直接只发布 Worker。

## 使用的 Cloudflare 基础设施

| 服务 | 用途 |
| --- | --- |
| Workers（Rust / Wasm） | MCP 接口、短链跳转和流式上传／下载 |
| D1 | 资源元数据、上传会话、容量和操作状态 |
| Workers KV | 分享 ID 到资源的映射 |
| R2（Standard 私有桶） | 图片和文件正文 |
| Analytics Engine | 访问事件与最近 30 天的统计查询 |
| Access + Managed OAuth | 管理员登录和 MCP 客户端授权 |
| Cache API / Cron Triggers | 正文缓存／每 5 分钟恢复未完成操作、清理数据 |
| DNS + Worker Route | 把自己的域名接入服务 |

## 让 Agent 安装

在已克隆本仓库、可执行终端命令的 Agent 中发送下面的提示词，填入自己的部署信息。Token 提前保存到仓库外的 `0600` 文件，不要把明文贴进聊天。

```text
请按照当前仓库 docs/deployment.md 安装并部署 cf-content-share。

Cloudflare account ID：<账户 ID>
分享域名：<share.example.com>，所属 Zone：<example.com>
管理员邮箱：<本人邮箱>
Zero Trust 团队：<已有团队名；没有则填写希望创建的名称>
Cloudflare API Token 文件：<仓库外的绝对路径，权限 0600>

授权你安装所需工具链、创建本项目缺少的 Cloudflare 资源、配置专用 DNS、
Access 和 Managed OAuth，执行数据库迁移、设置 Secret 并部署 Worker。
先检查现有配置，复用匹配资源；不要覆盖其他服务、放宽已有准入策略或删除数据。
使用这个 Token 部署，并将它保存为 ANALYTICS_API_TOKEN 用于统计查询。
Token 不得出现在聊天、命令参数、日志或 Git 文件中。

完成后连接当前 Agent 的 MCP，安装仓库自带的分享 Skill，并验证登录、
短链、文件上传下载及统计。浏览器登录由我完成；缺权限或需要开通计费时
明确告诉我具体缺项，不要扩大权限或购买套餐。最后报告结果和未验证项。
```

Agent 复用仓库初始化脚本，通过 Cloudflare API 补齐 DNS / Access，再用 Wrangler 发布。仓库当前没有包办这些步骤的一键安装程序；提示词由有终端和网络访问能力的 Agent 执行。需要 Node.js 22+、Rust/Wasm 工具链和已接入 Cloudflare 的域名；创建 Token、必要的服务开通和本人登录仍需用户完成。

### Token 权限

在 [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) 创建 Custom Token，Account Resources 只选部署账户，Zone Resources 只选目标 Zone：

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

DNS 与两项 Access 权限用于让 Agent 配置域名、应用、团队和身份提供方；若已手动配置这些内容，可去掉对应写权限。控制台显示 Edit，API 文档中可能称 Write，见[官方权限表](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)。

同一个 Token 可完成部署与统计，但存入 Worker Secret 后仍有上述写权限。可另提供只有 `Account → Account Analytics → Read` 的 Token 作为统计 Secret；用于统计的 Token 不要限制为仅允许本机出口 IP。这里使用的是 Cloudflare API Token，MCP 登录与上传会话使用各自的令牌。

手动安装命令、Agent 执行顺序、配置项和升级方法见[部署与升级](docs/deployment.md)。

## 安装 Agent Skill

仓库提供 [cf-content-share Skill](skills/cf-content-share/SKILL.md) 和无 npm 依赖的[上传脚本](skills/cf-content-share/scripts/upload.mjs)。将整个 `skills/cf-content-share` 目录复制到 `~/.agents/skills/cf-content-share`，保留 `scripts/` 子目录；已有同名安装时先核对，不直接覆盖。Skill 需要 Node.js 22+ 和已登录的 MCP 连接。

典型请求：`用 $cf-content-share 把这个 PDF 分享出去，标题为“会议资料”，保留 7 天`。Skill 指导 Agent 通过 MCP 创建会话，再用 HTTP 上传正文；安装 Skill 不会自动上传文件。上传结果不明时按 Skill 查询原操作，不要直接重新上传。

## 本地开发与文档

```sh
npm run db:migrate:local
npm run dev
```

`wrangler.local.jsonc` 使用占位资源，不含生产 Route。本地 MCP 仍验证 Access JWT；`npm run check` 使用独立测试密钥和本地 workerd，覆盖服务、部署初始化及上传脚本，不连接云端。`npm run dry-run` 检查本地配置与发布包。

- [产品需求](docs/requirements/product.md)、[技术设计](docs/design/technical.md)
- [文件与恢复](docs/files.md)、[访问统计](docs/analytics.md)
- [部署与升级](docs/deployment.md)、[实现进度](docs/plan/implementation.md)
- [正式服务云端验收](docs/research/2026-10-11-formal-cloud-acceptance.md)、[兼容性实验记录](docs/research/2026-10-11-rust-wasm-compatibility.md)
