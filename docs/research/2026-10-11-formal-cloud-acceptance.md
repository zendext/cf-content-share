# 正式服务云端发布与验收

> 后续状态：同日按用户要求完全删除原型环境和代码，旧链接不再保留；Desktop MCP 已更名为 `cf-content-share` 并实际验证调用。下面的旧链接保留与回退说明仅记录发布当时的实验，现已失效；当前操作见[部署文档](../deployment.md)。

- 日期：2026-10-11；Cloudflare 时间为 UTC。
- 目标：`https://share.example.com`，Rust/Wasm 正式 Worker `cf-content-share`。
- 最终部署版本：`00000000-0000-0000-0000-000000000001`；首发代码基线 `099e140`，最终版本包含本次 AE 查询排序修复。
- 范围：Cloudflare Access Managed OAuth、Desktop MCP、官方 MCP SDK、D1/KV/R2、Analytics Engine 与优选入口。

## 发布配置及旧链接

独立正式 D1 `cf-content-share` 已应用 0001、0002；KV 为 `cf-content-share-mappings`，私有 Standard R2 为 `cf-content-share`，AE dataset 为 `cf_content_share`，时区默认 `Asia/Shanghai`。`ANALYTICS_API_TOKEN` 按用户明确要求复用既有部署 Token，保存为 Worker Secret；未创建额外 Token，仓库与日志没有凭据明文。API 回读确认 Secret 名称与 `*/5 * * * *` Cron。

DNS 保持灰云 CNAME → `edge.example.net`。主 Route 指向正式 Worker；原型两个已有 stored 资源通过更具体的 `/r/<43 位 ID>*` Route 继续由原型提供，不复制到正式模型。切换前后分别读取不带和带查询参数的 URL，两个 59 字节对象均返回相同 SHA-256。原型 D1/R2 保留；正式管理和统计不包含原型对象。具体保留路径见原型路由配置（已删除，见历史版本 `0f79294`）。[Cloudflare Route 匹配规则](https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior)说明更具体路径优先及尾部通配符与查询参数的关系。

发布当时原型 SQL、原 Route 和对象摘要清单备份位于执行主机的 `<private-release-dir>/`，目录／文件仅当前用户可读；这些原型专用备份随后随原型退役一并移除，正式验收报告仍保留。以下仅为当时回退方案，现已失效：回退时先停正式写入并回读当前 Route ID，再将主 Route script 切回原型；Wrangler 会重建 ID，不能盲用切换前 ID。两套存储都保留，不以删数据回滚。

部署命令为 `npx wrangler deploy --config wrangler.cloud.json`。首次上传成功但 Route 被原型占用，Wrangler 明确拒绝接管；通过 Routes API 更新 script 后重跑成功，触发器与版本 ID 已回读。未关闭 Access，也未改成 workers.dev 或橙云。

## 实际验证方法

发布前重新执行 `CARGO_TARGET_DIR="$PWD/target" PATH="$HOME/.cargo/bin:$PATH" npm run check`：fmt、Wasm Clippy、构建成功，首发 69 项测试通过，失败 0；AE 排序回归加入后重新完整检查 70 项通过，失败 0。部署后独立 Node 验收进程使用已安装的官方 MCP SDK 1.32.1、真实浏览器授权和回环回调；OAuth 凭据只保存在进程内，不提取 Desktop 私有凭据，不伪造 Access JWT。

Desktop 现有连接仍以本地别名 `cf-content-share-compat` 展示，但请求同一 `/mcp` 地址，实际 `describe` 已返回正式 14 项目录，`invoke(storage.get)` 成功。仅服务器显示别名沿用原型名称，不影响运行中的正式服务。

未认证以及错误 Bearer 的 `/mcp` 均为 401，并返回 Access 的 OAuth challenge。指定优选 IP `192.0.2.1` 的 HTTPS 请求同样返回该 challenge。Access policy 回读仅有本人邮箱 Allow；没有登录另一账户测试拒绝。

首次刷新实验的失败位于临时验收客户端：直接 `discoverOAuthServerInfo(serverUrl)` 默认发现落到分享 origin，refresh 请求返回正式服务 404。对比仅增加 challenge 中的 `resource_metadata` 参数，得到 `example-team.cloudflareaccess.com` 的正确 token／revoke endpoint；重新授权后刷新成功并可调用工具。正式 Rust 代码未修改。客户端应遵循实际 `WWW-Authenticate` 地址，不硬编码标准发现路径。

## Analytics Engine 真实平台修复

第二轮在 136 秒内读到全部 5 次测试访问，summary 和 trend 成功，但 referrers 返回 `ANALYTICS_QUERY_FAILED`。直接提交相同 SQL 复现 HTTP 422：`unable to find type of column: "blob4"`；只把 ORDER BY 的源列改成 SELECT 输出别名即 HTTP 200。样本的 `double1` 源列同样复现。统一修复来源、地区、热门资源及样本的排序名称后，新增外部平台边界回归由失败变为通过，再部署最终版本并重新运行完整云端验收。HTTP 错误仍向客户端返回稳定脱敏错误，没有暴露原始 SQL 或 Token。

## 验收结果

最终部署的完整验收进程退出 0，报告 `success=true`：

| 范围 | 实际结果 |
| --- | --- |
| MCP | Desktop 原生工具调用成功；官方 SDK initialize、tools/list、describe、invoke 成功，仅两个工具、14 项操作 |
| OAuth 登录 | 独立客户端动态注册、PKCE、浏览器授权、state 回调验证成功，签发 refresh token |
| OAuth 刷新 | 显式刷新返回新 access token；将客户端 access token 替为无效值触发 401 后，SDK 自动刷新并重试工具成功；未等待自然 15 分钟到期 |
| OAuth 撤销 | refresh token 撤销接口 200，后续刷新被拒绝；既有 access token 最初仍返回 200，独立复查 30 秒后已为 401，不声称即时撤销；`token_type_hint=access_token` 的单独撤销请求为 400 |
| URL | 正式 12 位 ID，匿名 GET 302 指向原目标；HEAD 同状态无统计事件 |
| 文件 | 32 MiB 分块 multipart 上传 201，两次匿名下载 SHA-256 一致；单 Range 206 字节正确，HEAD 200，越界 416 |
| SVG | 75 字节原样返回 `image/svg+xml` 与 inline，字节完全一致 |
| 上传授权 | 会话撤销后相同上传 Token 返回 401 |
| 容量 | 上传后 published=33,554,507，reserved=cleanup=0；删除后全部为 0 |
| 统计 | 验收启动后 121 秒（含浏览器授权及上传时间）内读到 5 次访问：URL=1、文件=3、图片=1；文件包含两次 200 和一次 206，HEAD／416 没有混入 |
| 视图与分页 | summary、trend、referrers、regions、top 全部通过；默认时区 Asia/Shanghai；样本每页 2 条、游标下一页无重叠 |
| 历史元数据 | Desktop 查询已删除测试资源，仍返回历史计数与 `resource.state=deleted` |
| 清理 | 三轮验收的测试资源均逻辑删除，上传会话撤销；最后一轮的三个公开 URL 均为 404；保留必要墓碑与操作记录 |

最终验收资源为 `example-resource-id`（URL）、`example-resource-id`（32 MiB 文件）、`example-resource-id`（SVG），现在均为删除状态。32 MiB 正文 SHA-256 为 `371036ccdfc733fa30542a26a4f276536147c906d1570f0becc1d6f8b868c311`。本地原始报告和备份保留在上述私有 release 目录；没有保存 OAuth 或上传 Token 明文。

## 证据边界

统计是平台加权估算，本轮 5 次验收的小样本精确匹配不保证所有流量完整无采样。121 秒是本轮观测，不是长期 SLA。两次完整下载证明重复访问字节与计数正确，没有通过云端故障注入证明第二次一定命中 Cache API；缓存隔离证据仍来自本地 workerd。

OAuth 撤销在本轮具有传播延迟；30 秒后的 401 不保证所有节点都在同一时限失效。API 配置／token response 的 access lifetime 为 900 秒，[Managed OAuth 设置](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#managed-oauth-settings)说明短 access token 与长 refresh grant 的区别。没有登录其他人的账户、等待自然 Token 过期，也没有验证 Hermes。

Cloudflare Cron 已发布并回读配置，本轮没有人为制造线上故障任务证明实际定时恢复。云端 R2 并发屏障、上传中断恢复、跨节点 KV 传播和浏览器长期缓存另有故障注入验收边界，不能用正常上传成功替代。Free Website 的 100 MB 请求限制继续适用。

Documentation impact：更新根 README、技术设计、部署、文件、统计、实现进度、编排台账和原型入口说明。最终配置、Markdown 链接、代码 diff 和凭据泄漏检查通过；此次修复没有变更公开接口、迁移或资源 ID 规则。
