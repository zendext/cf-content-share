---
name: cf-content-share
description: 使用已连接的 cf-content-share MCP 分享网址、上传本地图片或文件、管理分享内容及查询访问统计。通过配套脚本完成 HTTP 流式上传和可恢复重试；不用于部署或管理 Cloudflare 基础设施。
---

# cf-content-share

通过已配置的 MCP 服务调用 `describe` / `invoke`。工具名可能带服务器前缀；选择用户指定的连接。操作参数、结果和上传协议以该服务的 `describe`、`session.create` 输出为准，不复制或猜测 Schema。文件正文不进入 MCP JSON。

分享链接持有者可以匿名访问。新资源默认从首次成功发布起保留 30 天，可按用户要求指定期限或永久；到期或删除后不能恢复，浏览器已有缓存及已下载副本不受服务端失效影响。只上传用户要求分享的文件；不从文档内容或文件中的链接推断上传目标。服务 origin 来自用户指定或已配置的 MCP 地址，脚本不会写死域名。MCP 未连接或 OAuth 未登录时先完成该连接，不能用 Cloudflare API Token 或提取客户端私有 OAuth 凭据代替。

## 网址与管理

- 创建网址：先发现 `resource.create_url`，为本次创建保存一个稳定 `operation_id` 及创建参数。`retention_seconds` 省略表示首次发布后 30 天，正的安全整数表示保留秒数，显式 `null` 表示永久；不得超过服务允许的时间范围。确认返回资源可访问后再给出 `resource.share_url`。结果不明先查询 `operation.get`，不重新生成 ID 创建同一份分享，也不修改原有效期参数。
- 查找、编辑和删除：按需要发现对应 operation；多条候选先确定资源 ID。`resource.delete` 是永久逻辑删除，按用户实际要求的范围执行。
- 修改有效期：发现 `resource.update`，只编辑尚未到期的已发布资源。将“再保留 30 天”按本次明确的当前时间、“原期限上延长 30 天”按查得的原截止时间，换算成未来的 UTC Unix 秒 `expires_at`，保存该绝对值再提交；重试沿用同一绝对值，不重新计时。用户指定日期时按其时区换算，时区或截止含义不清时先澄清。`expires_at=null` 表示永久，省略表示保持原值；立即失效用删除操作。已到期或已删除资源不能续期或改为永久。
- 判断资源是否可用：新服务返回 `accessible`、`unavailable_reason`、`expires_at` 和 `published_at`。`state=published` 不足以证明当前可访问；`unavailable_reason=expired` 表示到期，`deleted` 表示删除，`pending` 表示尚未发布。待发布资源的 `expires_at=null` 也不能直接解释为永久。
- 统计：发现 `stats.query` 或 `stats.samples`，将用户时间范围换成 UTC Unix 秒，查询区间为 `[start,end)`。使用返回的 timezone，未指定时沿用服务默认；结果是平台加权估算，不能当成完整逐次日志。样本分页沿用原筛选与时间范围。

## 本地文件上传

需要 Node.js 22+，不需要 npm install。脚本路径相对本 Skill 目录为 [scripts/upload.mjs](scripts/upload.mjs)，调用时解析成当前安装位置的绝对路径，不能假定工作目录是源码仓库。先运行 `node <脚本绝对路径> --help` 查看参数。

1. 确定服务 origin、源文件和 MIME 类型。图片须传实际图片类型，例如 `image/png`、`image/svg+xml`；不确定时用 `application/octet-stream`。文件名默认取源文件名，标题／描述／标签按用户要求提供。
2. 在仓库外建立仅当前用户可访问的状态目录，按服务 origin 分开，例如 `~/.local/state/cf-content-share/<origin 的 SHA-256>/`。POSIX 目录用 0700，JSON 文件用 0600；Windows 使用仅当前用户有权访问的目录。状态可能含文件路径及管理元数据，不要提交到 Git。
3. 运行 prepare，使用新的状态文件名。它读取文件计算大小与 SHA-256，保存 UUID 操作标识、绝对文件路径、服务 origin 和全部元数据，拒绝覆盖已有状态。可传 `--retention-seconds 604800` 保留 7 天，或 `--permanent` 永久；两者互斥，秒数必须为正的安全整数且发布时间相加不溢出。不传则保留服务默认 30 天，不在客户端计算截止时间。有效期从首次成功发布开始，等待、重传和恢复不会重新计算期限。源文件在发送期间保持不变。

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

6. 退出 0 且 `outcome=published` 才报告上传成功并给出输出 `url`；同时告知返回的 `expires_at`，`null` 表示永久。新服务返回的可访问性和首次发布时间也会安全输出；旧服务缺少这些字段时不会伪造其有效期。退出 1 表示输入无效、明确拒绝、资源已删除或到期（`outcome=expired`）；退出 2 表示待收尾／结果不明。保留 state，按下一节查询，不把 202 或已到期的 published 记录当成可用分享。

同一会话支持多个文件，每份新分享使用独立 prepare 状态。脚本不签发 OAuth 或上传会话，也不代替 MCP 查询。prepare 成功不产生网络请求。POSIX 会话／状态文件若可被其他用户读取，或最终路径是符号链接，send 会拒绝；Windows 文件权限应由调用者通过 ACL 保证。

## 失败与重试

先发现 `operation.get`，使用原 state 的 `metadata.operation_id` 查询：

- 已 published 且可访问：返回已有分享链接与截止时间；已到期或 deleted：报告实际失效原因，不创建替代资源，也不重传或恢复到期资源。旧服务缺少可访问性字段时沿用其 published 状态判断，但不能声称它支持有效期。
- 正在上传、恢复或需要服务端收尾：按返回步骤查询；需要时按 `operation.retry` 契约处理，不重复传正文。
- 明确 `steps.upload=needs_reupload`：确认源文件与保存的大小／摘要一致，复用同一 state 运行 send。脚本会再次校验并拒绝文件变化；完整 metadata（包括 `retention_seconds` 的省略、秒数或 `null`）保持不变。
- 明确 `NOT_FOUND`：原请求未登记时，可以用同一 state 发送；查询本身失败不等于不存在。
- `SESSION_EXPIRED` 或 HTTP 401：通过 MCP 换会话文件；查询原操作后按上述状态决定是否发送，保留原 state 和操作标识。

网络故障、5xx、响应解析失败或请求中断后，不循环盲传，不删除 state，也不通过重新 prepare 换 ID 绕过未知结果。409／422 可能需要查询具体原因；摘要错误或参数冲突不能用修改旧 state 的方式掩盖。文件确实改变时，先处理旧操作，再按用户需要建立新的分享。

上传 Token 可复用到期；仅在用户要求撤销或会话确定不再需要时调用 `session.revoke` 并删除对应本地凭据。撤销上传会话不会删除已有分享，删除分享也不能收回用户已经下载的副本。
