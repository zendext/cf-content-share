# 访问统计

`stats.query` 和 `stats.samples` 通过 MCP `describe` / `invoke` 调用。访问采集只提交到 Analytics Engine，D1 保留管理资源的标题与删除状态，不保存访问事件。具体参数 Schema 以 `describe({operation: ...})` 为准。

## 采集与配置

公开响应统一在出口调用 `stats::collect`；GET 的 302、200、206 各提交一次，HEAD、304、错误不提交。重试、范围请求、机器人、预览、缓存命中和删除传播期间仍成功的响应适用相同口径。采集使用本次实际提供的资源类别，不重新读取 D1 判断类别。服务端成功提供响应不代表客户端已下载完整文件。

| 配置 | 类型 | 用途 |
| --- | --- | --- |
| `ANALYTICS` | Analytics Engine binding | 写入数据集 |
| `ANALYTICS_DATASET` | var | 与 binding 一致的数据集名，匹配 `[A-Za-z_][A-Za-z0-9_]{0,127}` |
| `CLOUDFLARE_ACCOUNT_ID` | var | 32 位十六进制账户 ID |
| `ANALYTICS_API_TOKEN` | Worker Secret | 仅该账户的 Account Analytics Read 查询权限 |
| `DEFAULT_TIMEZONE` | var | 默认 `Asia/Shanghai`，查询可覆盖 |

查询密钥只用于服务端固定 Cloudflare SQL 地址，不进入发现目录、结果或日志；禁止跟随 SQL HTTP 重定向。查询未正确配置时返回 `ANALYTICS_NOT_CONFIGURED`。

事件字段由 [stats.rs](../src/stats.rs) 集中定义：

| 字段 | 内容 |
| --- | --- |
| `index1` | 资源 ID，作为平台采样索引 |
| `blob1` | 随机事件标识，12 位字母数字 |
| `blob2` / `blob3` | 资源 ID / 实际提供的类别 `url`、`image`、`file` |
| `blob4` | 请求提供的 Referer 原文 |
| `blob5` / `blob6` / `blob7` | Cloudflare 提供的 country / region / city |
| `double1` / `double2` | UTC Unix 秒 / HTTP 响应状态 |

缺失的来源或地理字段写入空字符串，输出为 `null`（未知），不猜测地理细度。所有 blob 的 UTF-8 字节数合计不得超过 16 KiB，index 不超过 96 字节。超限不截断，记录 `ANALYTICS_EVENT_TOO_LARGE` 并放弃该次采集；原生写入调用失败记录 `ANALYTICS_COLLECTION_FAILED`。日志不带 Referer、token 或异常原文，采集失败不改变公开响应。原生同步提交后由 Workers 运行时后台发送；无法证明平台最终接收或持久化完整性。

## 查询契约

两个操作都要求显式 `start`、`end`，为 UTC Unix 整数秒，范围 `[start,end)`；必须在调用时最近 30 天内，`start < end <= 当前时间`。超出窗口返回 `INVALID_TIME_RANGE`，不裁剪。可选 `resource_id`、`kind`、`timezone`；时区用 Worker `Intl.DateTimeFormat` 的 IANA 数据库校验，不接受固定偏移字符串，不支持的时区返回 `INVALID_TIMEZONE`。

`stats.query` 的 `view` 必填：

| view | items 的主要字段 | 额外参数 |
| --- | --- | --- |
| `summary` | `visits` | 不接受 limit 或 granularity |
| `trend` | `bucket_start`、`visits` | `granularity`: `hour` 或默认 `day`；不接受 limit |
| `referrers` | `referer`、`visits` | limit 默认 20，最大 100 |
| `regions` | `country`、`region`、`city`、`visits` | limit 默认 20，最大 100 |
| `top` | `resource_id`、`kind`、`visits`、`resource` | limit 默认 20，最大 100 |

所有 visits 均来自 `SUM(_sample_interval)`，不以行数代替访问量。来源按原始 Referer 分组。趋势由 Analytics Engine `toStartOfInterval(toDateTime(double1), INTERVAL '1' HOUR|DAY, timezone)` 分桶，`bucket_start` 返回 UTC Unix 秒；秋季重复小时具有不同 UTC 起点。趋势只返回平台观察到的桶，不填补未知桶为零；最多 750 桶足以覆盖 30 天小时／天粒度。summary 不受列表或排行 limit 影响。

`stats.samples` 额外支持 `referer`、`country`、`region`、`city` 精确过滤，空字符串用于过滤缺失字段。SQL 使用 `hex(column) = 'UTF8HEX'` 比较，原始文本不作为 SQL 字面量插入。默认 20 条，最多 100 条，保留事件标识、资源 ID、类别、UTC 秒、状态、原始来源与地区、`_sample_interval`。先按时间倒序，再按事件 ID 倒序。`next_cursor` 绑定所有筛选、实际时区、窗口和排序；续查可修改 limit。游标与条件不符返回 `INVALID_CURSOR`。

两个操作返回实际 `start` / `end` / `timezone` / `granularity`、`sampling`、`completeness: "unknown"` 和可确认的 `diagnostics`。平台样本的 `has_more` 仅表示本次查询观察到下一页，不代表完整访问日志、固定分页快照或固定误差率。采样及数据到达延迟可能改变续页的可见集合。

排行和样本中的资源，以及显式 resource_id 过滤的顶层 resource，由一次 D1 查询补充 `id`、`title`、`state`、`expires_at`、`published_at`、`deleted_reason`、`accessible` 和 `unavailable_reason`，包括已删除或已到期资源。到期但尚未被 Cron 删除的记录可同时为 `state=published`、`accessible=false`、`unavailable_reason=expired`。元数据缺失时 state 为 `unknown`；D1 失败另附 `RESOURCE_METADATA_UNAVAILABLE`，不改变加权访问量。短链目标修改不重置资源统计，不拆分历次目标。

HTTP / 网络查询失败返回 `ANALYTICS_QUERY_FAILED`，JSON 或结果结构异常返回 `ANALYTICS_RESPONSE_INVALID`；不伪造零访问量。HTTP 200 的平台 error 对象同样脱敏为固定业务错误。读取上限 12 MiB，覆盖最多 101 条样本、每条 16 KiB blob 及 JSON 最坏六倍转义；超限明确失败。

## 验证与证据边界

本地 Worker、真实 D1 / KV 与 MCP SDK 测试使用外部 Analytics SQL mock 和同步 writeDataPoint 边界替身：

```sh
PATH="$HOME/.cargo/bin:$PATH" CARGO_TARGET_DIR="$PWD/target" npm test
```

测试验证 302 统一采集、重复／机器人／预览／删除传播、HEAD 和错误排除、UTF-8 超限不截断、失败不阻断、原始地区、加权查询、全部固定视图、窗口和时区拒绝、样本游标、删除元数据、长 Referer 和错误脱敏。

文件统计集成测试使用真实上传、R2、KV 和 Cache API，检查 200／206、重复／机器人／预览各采集一次，HEAD、404、416、R2 失败不采集。Cache API 完成实际写入后，故障替身强制 R2 get 失败，缓存读取仍返回原始字节且恰好采集一次。删除测试模拟本地缓存清理失败和旧有效 KV 映射，成功提供的原始 SVG 仍按实际 image 类别计数；即使 D1 资源表暂时不可读也不影响采集，墓碑生效后缓存不能绕过拒绝且无新事件。文件完整／范围响应在采集失败时仍保留原字节。测试入口与故障开关仅在 tests fixture 中。

当前文件服务不生成 ETag，也不处理条件请求为 304；携带 If-None-Match／If-Modified-Since 的请求仍返回 200 并计数。采集函数的状态过滤排除 304，但没有可到达的正式 304 响应路径，因此不宣称已验证该路径的运行时集成行为。

2026-10-11 对真实 Analytics Engine endpoint 执行了只读合成常量 SQL，不访问用户数据集、不写入事件。可用本地查询凭据复核：

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> node tests/stats-cloud-probe.mjs
```

脚本从本地 `CLOUDFLARE_API_TOKEN` 读取凭据，不打印凭据或上游错误正文。它证明实际 SQL 支持 UTC 秒转换、时区分桶与 UTF-8 hex：纽约 2026-03-08 春季跳时、2026-11-01 秋季重复小时，以及上海 2026-10-10 16:30Z 的本地次日边界均符合预期。该证据不证明数据集读取、云端事件投递完整性或 5 分钟可见性；后者仍需正式绑定部署后的端到端验收。

官方依据（2026-10-11 核对）：[SQL API 与采样权重](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)、[时区函数](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/date-time-functions/)、[hex](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/encoding-functions/)、[数据点大小限制](https://developers.cloudflare.com/analytics/analytics-engine/limits/)、[后台提交行为](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)。

## 正式云端查询兼容性

真实 Analytics Engine 在 `SELECT blob4 AS referer` 后拒绝 `ORDER BY blob4`，HTTP 422 为 `unable to find type of column`；只把排序改为 `referer` 即成功。样本的 `double1`／`blob1` 同样如此。来源、地区、热门资源及样本统一按 SELECT 输出别名排序，WHERE 和 GROUP BY 仍使用原列；没有改变分组维度、排序方向或游标语义。

回归在外部 SQL 边界复现此约束，修复前失败、修复后完整检查 70 项通过。真实视图、样本分页、访问计数及投递延迟见[正式云端验收](research/2026-10-11-formal-cloud-acceptance.md)，不再用仅返回固定 JSON 的 SQL mock 作为平台兼容性的证据。
