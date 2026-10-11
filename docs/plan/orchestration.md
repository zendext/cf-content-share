# 剩余功能编排台账

- 2026-10-11；用户显式调用 `task-orchestration`。
- 稳定基线：`81a26d5`，第一批正式代码已提交并推送 `origin/main`，16 项本地测试通过。
- 主 Agent 负责设计、review、组合验证与集成；子 Agent 不继承对话，各自在隔离 worktree 实现，不推送或改变云端。

## 任务与依赖

| 任务 / Agent | 输入与输出范围 | 依赖 | 实现 | Review | 验证证据 | 集成 |
| --- | --- | --- | --- | --- | --- | --- |
| 文件 / files | 根 Rust 文件、会话、容量、缓存、恢复；0002 迁移、对应测试、docs/files.md | 81a26d5 | beaf3ae + 14add35 | 已 review，上传隔离与历史错误保留问题已修复 | 父级独立 target check 38/38；160 MiB 内存证据 | 9c0d76b + 6bd2961 |
| 统计 / analytics | stats.rs、AE SQL 与采集、MCP 接线、统计测试、docs/analytics.md | 81a26d5 | 0b3bcc4 | 已 review，脱敏与响应上限问题已修复 | 父级独立 target check 26/26；真实只读时区 probe | a329d67，统一公开响应接线 |
| 部署 / deployment | 初始化 CLI、配置示例、测试、docs/deployment.md | 81a26d5 与既定 binding 契约 | 709485c + 712d873 | 已 review，补上 R2 Standard 校验 | 父级 17/17；子目录配置 dry-run 与迁移发现通过 | 8e07eb4 + a9d31e5，完整配置及迁移通过 |

DAG：基线 → 三项并行实现与各自 review → 文件先集成 → 统计接线 → 部署配置与迁移检查 → 完整组合验证与文档同步。依赖集成后的工作只从已 review 的稳定状态开始。

## 固定契约

- Rust/Wasm、单 Worker、D1 权威数据、KV 60 秒绝对新鲜度、私有 R2、Cache API、AE、5 分钟 Cron；不得新增 DO、Queues、自有 OAuth 或访问日志库。
- 仅两个 MCP 工具；正式目录最终涵盖技术设计中的 14 项操作。
- bindings：DB、MAPPINGS、FILES、ANALYTICS；变量 ANALYTICS_DATASET、CLOUDFLARE_ACCOUNT_ID、DEFAULT_TIMEZONE（Asia/Shanghai）；Secret ANALYTICS_API_TOKEN。
- 公开读取返回 response 与实际服务的 kind（PublicRead），由统一响应出口按 GET+302/200/206 采集。不能事后重查 D1 决定已返回内容的类别。
- 0001 已成为升级基线，新增功能必须通过后续迁移保留原资源、ID、操作及链接。
- 仅租约到期不能证明活跃上传已停止。文件实现采用独立心跳维护活动占用；接管时通过 D1 CAS 和同键 R2 条件写入标记阻止旧请求后续提交，确认隔离后才释放预留或允许同 ID 换尝试 key 重传。标记未能确认安全删除时保留，不能用租约超时直接删正文。该内部协议需要并发故障证据，正式行为说明由文件模块维护。
- 线上 Route 与灰云 CNAME 保持当前配置；正式接管前必须明确原型链接兼容策略。云端变更与发布不作为子 Agent 权限。

## Review 记录

主 Agent 在实际代码 review 后补充 findings、原 Agent 修订、最新验证与集成结果。只有全部已授权实现与组合验证完成后才标记交付；本地故障注入与真实 Cloudflare 证据分别记录。

## 平台只读检查

- 主 Agent 使用既有 Token 向账户 AE SQL 接口执行 `SELECT 1 AS probe FORMAT JSON`，HTTP 200、返回 probe=1；没有写入事件或读取用户数据。统计 Agent 已验证纽约春秋 DST、上海 UTC 边界与 UTF-8 hex 共 5 项真实只读函数 probe。

- 统计 review：HTTP200 平台 error 必须重建脱敏错误；样本响应上限覆盖合法 101 条最大 blob 转义体积。原 Agent 修订并通过父级复验。
- 部署 review：新建明确指定 R2 Standard，复用需回读存储类型；InfrequentAccess／未知拒绝，原 Agent 修订并通过父级 17 项复验。
- 文件 review：已修复待发布负缓存、独立心跳、重传与旧恢复执行者隔离、KV/R2 分步失败状态，以及成功重传保留历史错误；原 Agent 提交后父级重新构建并通过 38 项检查。
- 构建隔离：本机继承 CARGO_TARGET_DIR=/tmp，所有最终构建均显式设为各 worktree 的 target，以防同名 crate 产物混用。
- 首次初始化只读预检：D1 列表正常，KV namespace 401 / 10000，当时在创建前停止；后续权限已补齐，见下方环境进展。

## 组合验证与交付

- Wave2 从已审查且集成的 `a9d31e5` 开始，仅授权统计 Agent 修改 2 个测试文件及统计文档，使用主工作区独占构建。父 Agent 逐项审查实际 diff；无新增发现，无生产代码故障开关。
- 完整 `npm run check`：fmt、Wasm Clippy、Wasm 构建成功，69 项测试通过、0 失败。覆盖 37 项服务、1 项 R2 平台原语、14 项统计和 17 项初始化回归。
- 4 项组合新增用例验证实际 Cache API 写入后禁用 R2 仍返回原字节、完整及范围响应恰好一次统计、SVG 删除传播中的成功读取类别，以及采集失败保留原响应。条件请求当前返回 200；没有可达 304 响应，不宣称完成其运行时集成验收。
- 主级 Wrangler 本地升级成功应用 0002，第二次无待执行迁移；包含全部 binding 的 dry-run 成功；启动最终配置后，MCP／上传鉴权 401、缺失资源 404、scheduled 200 符合预期。
- 根 README、技术设计和实现进度同步实际代码与验证边界。授权范围内的剩余代码已实现；正式云端发布及端到端环境验收尚未完成，线上原型未改变。

## 环境进展：权限补齐后

用户确认已补齐权限后，主 Agent 执行正式资源初始化：D1／KV／私有 Standard R2 创建成功，重复 `--apply` 全部复用原 ID；云端 0001／0002 迁移成功，重复迁移无待执行项；SQL 回读确认空资源表及三项容量计数为零。实际绑定配置 dry-run 通过，输出配置权限 0600 且被 Git 忽略。现有 Access、Route 和灰云 CNAME 已回读核对，当时正式 Worker 尚未发布，后续发布见下一节。详细证据和待验收范围见[部署与升级](../deployment.md#6-验收和可观测性)。

Documentation impact：更新部署文档、实现进度及本台账，解除已过时的 KV 权限缺口；配置解析、文档链接和最终 diff 检查通过。此次仅初始化云端环境及更新记录，没有修改正式服务代码，不重复执行代码回归。

## 正式发布与云端验收

用户进一步授权复用当前 Token 配置统计 Secret、发布到 `share.example.com` 并 commit + push。正式主 Route 已接管，两个已有原型链接用更具体的 Route 保留；原型 D1/R2 和 DNS 未清空或改写。真实 AE 暴露 ORDER BY 使用源列的 422，主 Agent 通过源列／输出别名单变量对照确认根因，先增加失败回归，再修复四处排序，完整检查 70/70 通过后重新发布。

最终版本 `00000000-0000-0000-0000-000000000001` 已通过 Desktop MCP、真实 PKCE 登录、显式及 401 自动刷新、refresh 撤销与 30 秒后 access 401、32 MiB 上传／摘要／Range／SVG、会话撤销、容量释放、五种统计视图与样本分页。本轮全部 5 次访问在验收启动后 121 秒可见。具体边界及备份见[云端验收](../research/2026-10-11-formal-cloud-acceptance.md)。
