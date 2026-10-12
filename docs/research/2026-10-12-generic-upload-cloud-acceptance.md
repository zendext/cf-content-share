# 通用 TypeScript 上传器发布与云端验收

> 隐私说明：不记录真实分享域名、账户／资源标识、Worker version UUID、用户文件名、Token 或私有凭据路径；部署版本以代码提交说明。原始发布、发现和验证产物保存在仓库外受限目录。

- 日期：2026-10-12。
- 实现与发布代码：`819c372`，Issue #3；本记录写入时 PR #4 仍为草稿、尚未合并。
- 状态：正式 Worker 已发布，API 回读新版本承接 100% 流量；真实 OAuth、发现、独立安装上传器、上传读取及测试资源／会话清理均已验收。
- 范围：既有 Worker、Route、Access Managed OAuth、D1/KV/R2 和 Cron；本次只有代码与本地 Skill 更新，没有新迁移，没有重复有效期激活，也未进入维护模式。

## 判断标准与环境

本轮验证服务端发现是否足以指导通用客户端：Agent 按实时 Schema 构造 metadata，客户端负责文件、生成字段和传输，最终可用性与分享地址由 MCP 权威操作结果确认。不能以 HTTP 201 或上传器退出 0 单独判定分享成功。

实际使用 Node.js 24.21.0、官方 MCP SDK 1.32.1、TypeScript 5.9.3 与 lockfile 中的 Wrangler 4.149.0。本地完整检查包括严格 TypeScript 无输出类型检查、Rust fmt、Wasm Clippy（`-D warnings`）、Rust/Wasm 构建和测试；正式配置独立 dry-run 后发布。浏览器完成真人 OAuth，验收客户端的 OAuth 凭据仅保存在进程内存，不读取其他客户端的凭据存储。

本地运行入口：

```sh
npm run check
npx wrangler deploy --dry-run --config /私有目录/wrangler.production.json
node /独立安装目录/cf-content-share/scripts/upload.mts --help
```

实际 Skill 已安装到用户的独立技能目录，并从该目录执行 prepare／send，运行期间无需 npm 安装。准备命令接收私有 `metadata.json`、发现返回的无凭据 `upload` 对象和新 state 路径；发送使用私有会话文件。完整参数见 [Skill](../../skills/cf-content-share/SKILL.md)。

## 发现契约与真实上传

线上 `describe(session.create).upload` 与实际 `session.create.upload` 完全一致；其中 `result_schema`、`result_semantics` 与 `operation.get` 的发现描述一致。发现无需签发上传会话。协议版本为 1，生成字段为 `operation_id`、`size_bytes`、`sha256`，当前服务元数据上限为 16,384 字节。

本轮生成合成测试文件，无用户私有内容。三份有效上传均先保存 metadata 与 state，再经同一 MCP 会话授权发送；HTTP 返回 201，上传器退出 0，stdout 仅有 `operation_id`、`transport_status`、`http_status`，不含资源业务结果或凭据。随后分别通过 MCP `operation.get` 确认操作 completed、资源 accessible=true 和期限：

| 输入 | 大小 | MCP 确认的期限 | 公开读取 |
| --- | --- | --- | --- |
| 省略保留参数 | 1 MiB | `expires_at = published_at + 2592000` | GET 200、HEAD 200、Range 206 |
| 自定义保留参数 | 54 字节 | `expires_at = published_at + 3600` | GET 200、HEAD 200、Range 206 |
| 显式永久参数 | 54 字节 | `expires_at = null` | GET 200、HEAD 200、Range 206 |

每份 GET 正文均与源文件逐字节一致；HEAD 使用 `Accept-Encoding: identity`，Content-Length 与源文件长度相等；单 Range 请求 `bytes=1-15` 返回 206，正文与对应片段一致。1 MiB 输入的 SHA-256 为 `fbbab289f7f94b25736c58be46a994c441fd02552cc6022352e3d86d2fab7c83`；54 字节输入为 `388ab7df64098a04636cfa0322b9570aa83cbb828a3bee811bfbdae20e3e2eaf`。

业务边界另用 `retention_seconds=0` 验证：通用 prepare 接受并保存该 JSON，不内置有效期校验；服务器返回 HTTP 400 / `INVALID_METADATA`，上传器退出 1 并只输出脱敏传输错误；MCP 查询原操作返回 `NOT_FOUND`，未创建持久上传任务。这证明业务校验仍由服务端负责，不表示客户端会绕过服务校验。

## v1 state 恢复与负面观察

将本轮默认上传的原 metadata 与操作标识保存为 v1 state 副本，用独立安装的上传器在真实线上重放。HTTP 返回 200、上传器退出 0；MCP 确认资源 ID 与期限不变，`total_attempts` 仍为 1。原 state 文件与 metadata 均未改写。该实验验证旧 state 格式可读取并保持幂等，不是重新上传一份新的资源。

最初 HEAD 长度断言失败：Node 默认请求协商了 `br`，Cloudflare 的编码响应未保留 Content-Length。仅将 HEAD 请求的 `Accept-Encoding` 改为 `identity` 后，54 字节测试内容返回相符长度，三组读取验证通过。没有修改产品代码，也不把这次断言失败归因于正文被截断。

## 本地验证与证据边界

最终冻结代码执行 `npm run check` 退出 0：严格 TypeScript、fmt、Clippy、构建全部通过，**107 项测试通过，失败／取消／跳过均为 0**。正式配置 dry-run 退出 0；部署后 API 回读版本承接 100% 流量。此次不重新运行旧迁移或有效期激活，发布后 D1 回读迁移列表和已有 T0 保持不变。

- 生产只验证当前业务 Schema。未来业务字段、嵌套 JSON 和结果语义变化由本地 fixture 验证，没有为了测试而在生产增加业务字段。
- 真实云端上传为 1 MiB 与 54 字节；16 MiB 流式上传、响应中断、权限、来源限制和其他故障分支由本地测试覆盖。
- 本轮没有重新验证自然 Cron、有效期迁移、OAuth 自然过期、Hermes 或跨节点传播；对应历史证据见[有效期验收记录](2026-10-12-expiration-cloud-acceptance.md)，不能视为本次新增实测。
- 原图片、原上传会话与原计时起点保留；测试只处理本轮创建的资源与会话。

## 清理与产物

三份测试资源均通过 MCP 删除，删除操作 completed、R2 清理 completed、资源 accessible=false；三个公开分享链接均返回 404。随后再次查询原上传操作：操作仍为 completed，但资源已 deleted、accessible=false。这项实际结果再次说明操作完成不等于当前可访问。

| 最终读回 | 结果 |
| --- | --- |
| 资源 | 1 条 published、20 条 deleted；MCP 列表只有原图片，`has_more=false` |
| 操作 | 45 条，全部 completed |
| 容量 | published=12134 字节，reserved=0，cleanup=0 |
| 原图片 | 12,134 字节、SHA-256 和原期限 1794364142 均不变 |
| 有效期激活 | T0=1791772142，迁移数量仍为 1；没有重新计时 |
| 迁移记录 | 仍为 0001、0002、0003；本轮没有执行新迁移 |
| 会话 | 本轮会话已撤销，原有效会话仍有 1 个 |
| 部署 | 仍为本轮代码版本承接 100% 流量；全部 bindings 与发布前严格一致 |

使用本轮已撤销的会话再次调用 send，返回 HTTP 401 / `UNAUTHORIZED`，退出 1；没有影响原会话。OAuth 验收客户端正常退出并清空内存凭据，本轮私有会话凭据文件已移除。独立安装的 Skill 与上传器两个文件的 SHA-256 与冻结源码一致，构建产物摘要与部署前一致。


可复核的私有产物包括最终检查与 dry-run 日志、部署日志和版本回读、脱敏发现对象、各次传输摘要、MCP 操作结果、上传读取断言及 v1 重放对比。会话凭据另存私有文件，不随这些摘要输出，也不提交到仓库。

Documentation impact：README 与实现记录同步本轮部署和验收范围；Skill 与文件契约保留由发现驱动的稳定工作流，不把这些测试输入或具体业务枚举重新写成本地上传规则。
