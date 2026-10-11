# cf-content-share

基于 Cloudflare 的轻量内容分享服务，支持网址、图片和其他文件，通过 MCP 等 Agent 接口管理内容并查询访问统计。

项目面向单人自部署、自用。以自动生成的短 URL 作为分享入口，持有链接即可访问，不提供自建管理 GUI。

首版需求与技术方案已确认。根目录已实现正式 Rust/Wasm 服务：短链与文件管理、流式上传、容量预留、KV／正文缓存、Cron 恢复、访问统计查询和可重复初始化 CLI。正式 Worker 已部署到 `share.example.com`，本地 workerd 和云端验收范围见下方文档。完整方案采用 Rust/Wasm Worker、D1、KV、R2 和 Analytics Engine。

正式服务已通过 Desktop MCP 工具调用、Managed OAuth 登录与刷新、32 MiB 流式上传及下载摘要校验；详细结果见[正式服务云端验收](docs/research/2026-10-11-formal-cloud-acceptance.md)。原型代码和云端资源已退役，Desktop MCP 名称为 `cf-content-share`。域名仍使用灰云 CNAME → `edge.example.net`；当前 Free Website 套餐单请求体上限为 100 MB，Workers Paid 不提高这一限制。

当前入口采用 Worker Route＋灰云 CNAME 到 `edge.example.net`，正式服务沿用已验证的优选入口；DNS 记录独立于 Wrangler 的 Route 配置维护。

- [产品需求](docs/requirements/product.md)：产品范围、资源模型、统计与删除规则及验收标准。
- [技术设计](docs/design/technical.md)：组件职责、认证、MCP 接口、上传、缓存、失败恢复、部署与验证安排。
- [文件与恢复](docs/files.md)：上传会话、容量、重传、对象防覆盖和缓存。
- [访问统计](docs/analytics.md)：采集字段、加权查询、时区与样本分页。
- [部署与升级](docs/deployment.md)：初始化 CLI、Access、Secrets、迁移与发布。
- [正式服务实现进度](docs/plan/implementation.md)：当前接口、验证证据、后续批次与上线边界。
- [兼容性实验记录](docs/research/2026-10-11-rust-wasm-compatibility.md)：已退役原型的历史实测记录。

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

本地迁移可重复执行。`npm run init:cloud -- --config deployment.local.json` 默认只读预览，显式 `--apply` 才创建缺失的正式 D1/KV/R2 资源和生成生产配置，具体见[部署与升级](docs/deployment.md)。统计 SQL 依赖真实 Analytics Engine 和 Worker Secret，本地开发绑定不会提供可查询的真实访问统计。Desktop 通过 `cf-content-share` 连接 `https://share.example.com/mcp`。

## 安装 Agent Skill

仓库提供 [cf-content-share Skill](skills/cf-content-share/SKILL.md) 和无 npm 依赖的 [上传脚本](skills/cf-content-share/scripts/upload.mjs)。它指导 Agent 使用已连接的 MCP 完成分享、上传及结果不明时的恢复；不会自动部署服务、配置 Cloudflare 或上传本地文件。

需要可用的 cf-content-share MCP 连接及 Node.js 22+。尚未连接时，替换为自己的服务地址执行；已有连接不必重复添加：

```sh
codex mcp add cf-content-share --url https://share.example.com/mcp
# 若还需单独登录：
codex mcp login cf-content-share
```

在本仓库根目录执行下列命令，把 Skill 链接到用户级目录（Linux/macOS）。目标已存在时命令会停止，不覆盖已有安装：

```sh
mkdir -p "$HOME/.agents/skills"
node --input-type=module <<'JS'
import { realpath, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
const source = await realpath('skills/cf-content-share');
const target = path.join(homedir(), '.agents/skills/cf-content-share');
await symlink(source, target, 'dir');
console.log(target);
JS
```

链接方式随本仓库更新；不要再移动或删除源目录。希望固定一份安装时，也可以把整个 `skills/cf-content-share` 目录复制为 `~/.agents/skills/cf-content-share`，保留 `scripts/` 子目录。项目级安装可放到目标项目的 `.agents/skills/cf-content-share`。不要在多个扫描位置重复安装同名 Skill；已有同名安装时先核对路径，再决定更新方式。[Codex Skill 加载规则](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)。

Codex 支持自动发现 Skill，也可在任务中写 `$cf-content-share`。没有出现时重启 Codex；MCP 配置变更后在 Desktop 的 MCP servers 设置中 Restart。其他 Agent 可复制整个目录到其支持的 Skill 位置，并单独连接 MCP。此处只提供安装方法，不会替用户修改全局 Skill 配置。

典型请求：`用 $cf-content-share 把这个 PDF 分享出去，标题为“会议资料”`。Agent 将先发现 MCP 协议，再用脚本准备状态、读取私有会话文件并上传。手动查看脚本参数：

```sh
node skills/cf-content-share/scripts/upload.mjs --help
```

上传状态分为两个命令：`prepare` 计算摘要并保存固定操作标识，`send` 复用同一状态发送一次。`send` 退出 0 表示已发布；退出 1 表示本地输入或明确拒绝；退出 2 必须通过 MCP 查询 `operation.get`。不要把 202 当作上传成功，也不要在结果不明时重新 prepare 生成新 ID。Session JSON 保存 `session.create` 的结构化结果对象，Token 不通过命令行传递；POSIX 文件需为当前用户所有、0600 或更严格，Windows 需通过 ACL 限制访问。具体上传、会话复用及恢复步骤都在 Skill 中。

验证：`npm run check` 包含 `tests/upload-skill.test.mjs`。仅运行客户端检查时，先 `npm run build`，再执行 `node --test tests/upload-skill.test.mjs`；测试使用临时目录、本地 HTTP 和真实 workerd，不连接云端或留下有效上传会话。
