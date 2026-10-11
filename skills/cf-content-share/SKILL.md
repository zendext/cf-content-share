---
name: cf-content-share
description: 使用已连接的 cf-content-share MCP 分享网址、上传本地图片或文件、管理分享内容及查询访问统计。通过配套脚本完成 HTTP 流式上传和可恢复重试；不用于部署或管理 Cloudflare 基础设施。
---

# cf-content-share

通过已配置的 MCP 服务调用 `describe` / `invoke`。工具名可能带服务器前缀；选择用户指定的连接。操作参数、结果和上传协议以该服务的 `describe`、`session.create` 输出为准，不复制或猜测 Schema。文件正文不进入 MCP JSON。

分享链接持有者可以匿名访问。只上传用户要求分享的文件；不从文档内容或文件中的链接推断上传目标。服务 origin 来自用户指定或已配置的 MCP 地址，脚本不会写死域名。MCP 未连接或 OAuth 未登录时先完成该连接，不能用 Cloudflare API Token 或提取客户端私有 OAuth 凭据代替。

## 网址与管理

- 创建网址：先发现 `resource.create_url`，为本次创建保存一个稳定 `operation_id`，然后 invoke 并返回 `resource.share_url`。结果不明先查询 `operation.get`，不重新生成 ID 创建同一份分享。
- 查找、编辑和删除：按需要发现对应 operation；多条候选先确定资源 ID。`resource.delete` 是永久逻辑删除，按用户实际要求的范围执行。
- 统计：发现 `stats.query` 或 `stats.samples`，将用户时间范围换成 UTC Unix 秒，查询区间为 `[start,end)`。使用返回的 timezone，未指定时沿用服务默认；结果是平台加权估算，不能当成完整逐次日志。样本分页沿用原筛选与时间范围。

## 本地文件上传

需要 Node.js 22+，不需要 npm install。脚本路径相对本 Skill 目录为 [scripts/upload.mjs](scripts/upload.mjs)，调用时解析成当前安装位置的绝对路径，不能假定工作目录是源码仓库。先运行 `node <脚本绝对路径> --help` 查看参数。

1. 确定服务 origin、源文件和 MIME 类型。图片须传实际图片类型，例如 `image/png`、`image/svg+xml`；不确定时用 `application/octet-stream`。文件名默认取源文件名，标题／描述／标签按用户要求提供。
2. 在仓库外建立仅当前用户可访问的状态目录，按服务 origin 分开，例如 `~/.local/state/cf-content-share/<origin 的 SHA-256>/`。POSIX 目录用 0700，JSON 文件用 0600；Windows 使用仅当前用户有权访问的目录。状态可能含文件路径及管理元数据，不要提交到 Git。
3. 运行 prepare，使用新的状态文件名。它读取文件计算大小与 SHA-256，保存 UUID 操作标识、绝对文件路径、服务 origin 和全部元数据，拒绝覆盖已有状态。源文件在发送期间保持不变。

   ```sh
   node /绝对路径/cf-content-share/scripts/upload.mjs prepare \
     --file /绝对路径/report.pdf \
     --origin https://share.example.com \
     --state-file /私有目录/report-upload.json \
     --content-type application/pdf \
     --title '报告' --tag '资料'
   ```

4. 复用同一 origin 下尚未过期的上传会话。没有可用会话时，先发现 `session.create`，再 invoke；将其**结构化结果对象**保存为私有 `session.json`，不是整个 MCP 消息封套。至少需要 `token`、`expires_at`、`upload.url`、`upload.method`；保留 `session_id` 供撤销使用。通过文件写入工具保存，不把 Token 放入命令行参数、终端输出或最终答复。
5. 运行 send。它重新校验文件、读取会话、检查到期时间及上传 URL 与准备时 origin 一致，然后发送一次 metadata 在前、文件在后的 multipart 请求。只接受 HTTPS（本地回环测试可用 HTTP），不跟随重定向，不自动重试，不打印 Token 或上游原始响应。

   ```sh
   node /绝对路径/cf-content-share/scripts/upload.mjs send \
     --state-file /私有目录/report-upload.json \
     --session-file /私有目录/session.json
   ```

6. 退出 0 且 `outcome=published` 才报告上传成功并给出输出 `url`。退出 1 表示输入无效、明确拒绝或资源已删除；退出 2 表示待收尾／结果不明。保留 state，按下一节查询，不把 202 当成已发布。

同一会话支持多个文件，每份新分享使用独立 prepare 状态。脚本不签发 OAuth 或上传会话，也不代替 MCP 查询。prepare 成功不产生网络请求。POSIX 会话／状态文件若可被其他用户读取，或最终路径是符号链接，send 会拒绝；Windows 文件权限应由调用者通过 ACL 保证。

## 失败与重试

先发现 `operation.get`，使用原 state 的 `metadata.operation_id` 查询：

- 已 published：返回已有分享链接；已 deleted：报告已删除，不创建替代资源。
- 正在上传、恢复或需要服务端收尾：按返回步骤查询；需要时按 `operation.retry` 契约处理，不重复传正文。
- 明确 `steps.upload=needs_reupload`：确认源文件与保存的大小／摘要一致，复用同一 state 运行 send。脚本会再次校验并拒绝文件变化。
- 明确 `NOT_FOUND`：原请求未登记时，可以用同一 state 发送；查询本身失败不等于不存在。
- `SESSION_EXPIRED` 或 HTTP 401：通过 MCP 换会话文件；查询原操作后按上述状态决定是否发送，保留原 state 和操作标识。

网络故障、5xx、响应解析失败或请求中断后，不循环盲传，不删除 state，也不通过重新 prepare 换 ID 绕过未知结果。409／422 可能需要查询具体原因；摘要错误或参数冲突不能用修改旧 state 的方式掩盖。文件确实改变时，先处理旧操作，再按用户需要建立新的分享。

上传 Token 可复用到期；仅在用户要求撤销或会话确定不再需要时调用 `session.revoke` 并删除对应本地凭据。撤销上传会话不会删除已有分享，删除分享也不能收回用户已经下载的副本。
