# 资源有效期发布与云端验收

> 隐私说明：不记录真实分享域名、账户／资源标识、Worker version UUID、用户文件名、Token或私有备份路径；部署版本以代码提交说明。下列T0为实际激活时间，不是示例。

- 日期：2026-10-12，本文时间为UTC。
- 状态：有效期功能已迁移、激活并恢复服务；最终版本、真实客户端、自然Cron清理和测试资源／会话收尾均已验收。未验证边界另列，不将本轮结果扩大为全球传播保证。
- 实现基线：`c54a09f`；真实D1迁移兼容修正：`bf0abf6`；发现目录新鲜度修正：`6a3c626`。
- 范围：同一正式Worker、D1/KV/R2、既有Route与Access Managed OAuth；临时维护入口未增加认证旁路或产品持久开关。

## 维护、备份与迁移

约02:24发布静态维护入口，公开GET与`/upload`实际返回503；scheduled不执行业务。配置和资源归属保持不变，发布前核对没有未完成恢复操作及活动租约，并保留晚到旧执行的Schema防护。

D1 SQL导出23,724字节，在独立SQLite内存数据库执行恢复检查：12条resource、23条operation，外键检查0条错误。R2清单仅1个12,134字节对象，正文摘要与升级前公开下载一致。SQL、对象证据、原始输出与私有配置保存在仓库外受限目录。本次完成了独立SQLite恢复核对，没有把备份导回生产；它不能替代独立云端D1恢复切换演练。

首次远端应用0003返回`incomplete input`。立即回读确认整次迁移已回滚，没有留下部分列、触发器或迁移记录，也未开始旧资源倒计时。父级以只读`EXPLAIN`在生产D1隔离差异：原`SELECT CASE ... END;`触发器守卫返回HTTP400／7500，等价的`SELECT RAISE(...) WHERE ...;`返回HTTP200、changes=0。修正三个守卫语句并提交`bf0abf6`后，远端迁移17条命令成功；未削弱到期发布拒绝或时间溢出检查。该问题说明本地workerd／SQLite通过并不能替代真实D1迁移验证，不将其泛化为SQLite不支持CASE。

随后发布加载新正式bundle的兼容维护入口并回读100%流量，fetch和scheduled仍保持维护，再执行独立激活脚本。Schema准备和新代码加载本身均不启动旧资源计时。

## 实际T0与旧数据结果

| 项目 | 结果 |
| --- | --- |
| 激活T0 | `1791772142`，即 **2026-10-12 02:29:02 UTC**（北京时间10:29:02） |
| 旧资源统一截止 | `1794364142`，即 **2026-11-11 02:29:02 UTC**（北京时间10:29:02） |
| T0瞬间迁移数量 | 1条未删除资源 |
| 重复apply | T0、旧期限和迁移数量完全不变 |
| 旧数据核对 | 原12条资源的ID、对象key、state与容量均保留；11条旧deleted不恢复 |
| 旧图片 | 恢复服务后GET200，SHA-256与备份前相同，仍为`private, max-age=31536000, immutable` |

迁移前生产没有pending资源，所以“旧pending激活后发布保留截止”和晚到旧插入由本地回归证明，没有在生产制造用户pending任务。永久设置、旧操作指纹及重入的程序边界见[技术设计](../design/technical.md#104-有效期功能的一次性激活)。

恢复正式入口后回读生产为100%新版本。本次激活之后的代码小修复只发布新bundle，不重新激活或改变T0；不使用不认识有效期的旧Worker回滚。

## 真实MCP与公开读取

通过真人浏览器OAuth和官方MCP SDK使用现有Access认证，没有提取其他客户端的私有凭据，也没有伪造Access JWT。

| 验收范围 | 已取得证据 |
| --- | --- |
| 三种URL策略 | 实际创建默认30天URL、20秒URL、永久URL；D1与管理结果反映相应期限 |
| 绝对期限编辑 | 默认URL改为未来绝对截止，重复相同编辑不续期；普通title编辑不改变期限 |
| 永久与幂等 | 默认URL改为`expires_at=null`后重放原创建operation，返回相同资源ID及永久期限 |
| URL到期 | 短期URL到期后公开访问404；未手动触发scheduled，自然Cron将其转为`deleted_reason=expired` |
| URL自然清理证据 | 删除operation的created_at为`1791772242`，即02:30:42；由定时执行产生 |
| 文件默认策略 | 真实HTTP流式上传1 MiB普通文件返回201，期限为首次发布加2592000秒 |
| 文件幂等重发 | 生产真实流式重复请求返回200，资源ID、published_at、expires_at保持不变 |
| 自定义与永久上传 | 30秒SVG与永久空文件均返回201，D1的期限差／null符合参数 |
| 正文与HTTP分支 | 上传后GET摘要、HEAD与单Range验证通过；SVG先预热，再等到期 |
| SVG到点拒绝 | 到期后GET、HEAD、Range均404；详情仍可为published，但accessible=false且unavailable_reason=expired |
| 到期不可恢复 | 对已到期SVG设置永久返回RESOURCE_EXPIRED，默认列表排除该资源 |
| 文件自然清理 | 实际scheduled日志、SVG自动删除、R2清理完成及容量释放相互印证，没有人工触发或直接改状态 |
| 上传授权收尾 | 本轮上传会话撤销后再次上传401；不撤销原有会话 |
| MCP拒绝路径 | 匿名和错误Bearer请求均401，并返回OAuth challenge |
| 到期历史统计 | 真实`stats.query`使用`view=top`、短期SVG资源过滤及近1小时窗口成功；顶层和条目metadata均为deleted、accessible=false、unavailable_reason=expired、deleted_reason=expired |
| 最终资源列表 | 真实`resource.list`仅返回原1条image，期限仍为迁移确定的截止 |

上述结果证明这轮实际请求经过的生产路径，不证明所有节点在同一时刻同步，也不能单凭预热访问证明随后一定命中某个边缘Cache副本。统计查询证明真实Analytics Engine结果仍包含该历史image资源，并由D1补充当前失效状态；验收辅助程序未保留visits数值，因此不能声称本轮访问数精确一致。

## 本地回归与发现目录修正

云端验收发现`describe`的defaults还残留60秒；运行逻辑已使用86400秒，但发现信息与实际不一致。`6a3c626`将该字段改为引用运行常量，并新增目录断言。

最后一次本地完整检查使用Rust 1.97.1、worker-build 0.8.7与独立target目录执行`npm run check`，退出0；fmt、Wasm Clippy（`-D warnings`）、Wasm构建及**101项测试全部通过，失败／取消／跳过均为0**。其原始日志在私有发布目录，最终正式配置dry-run通过。`6a3c626`已发布并回读100%流量；bindings、Secret名称和五分钟Cron保持不变。真实`describe`返回86400，原图生产KV映射为version=1、expires_at=T0+30天、valid_until-observed_at=86400；没有重复激活。

本轮本地上传测试曾出现Miniflare提前响应时`ECONNRESET`，旧客户端与最小Worker也复现。最终保留16 MiB首次上传的真实HTTP流式路径、块大小不超过64 KiB及下载摘要验证；只有幂等重发测试在适配层收集Buffer后调用`dispatchFetch`，断言相同ID、published_at和expires_at。生产脚本仍流式上传，真实云端1 MiB流式重发已通过。另有响应流中断回归要求`unknown`、保留原operation_id且不自动重试，以及近安全整数上限参数重发回归。没有声称Miniflare问题已修复。

## 收尾状态与证据边界

本轮创建3个URL及3个上传资源，共6个测试资源。两个URL、默认文件和永久空文件已手动删除，四个链接均404且清理完成；短期URL与短期SVG均由自然Cron删除。SVG到期后、定时清理前的107字节仍计入published，未提前释放。私有tail随后捕获`*/5 * * * *`真实scheduled事件：scheduledTime=`1791772517000`，即02:35:17，outcome=ok、exceptions=0。D1中SVG变为`deleted_reason=expired`、`accounting=released`；删除operation于02:35:24创建、02:35:26更新为completed，r2_status=completed。整个验收没有手动触发Cron，也没有直接修改D1测试资源状态来制造结果。

最终回读：

| 项目 | 结果 |
| --- | --- |
| resources | 1条published、17条deleted（原12条加6条测试资源） |
| operations | 39条，全部completed |
| 容量 | published=12134字节，reserved=0，cleanup=0 |
| R2 | 清单逐字段与备份前一致，仅原1个对象 |
| 上传会话 | 原有效会话仍有1个；仅本轮会话已撤销 |
| T0 | 仍为1791772142，没有重新计时 |
| 最终代码与发现 | `6a3c626`，100%流量；describe与原图KV快照均为86400秒 |

仅撤销本轮创建的上传会话，之后用它上传返回401，未影响升级前已有会话。匿名和错误Bearer的MCP请求均401并带OAuth challenge；没有以Cloudflare管理API身份替代MCP用户认证。

已验证与未验证的边界：

- 实际激活、旧对象保留、真实OAuth、三种期限、新资源幂等、到点拒绝、URL及文件自然Cron清理都有本轮生产证据；测试资源、R2、容量和会话也已核对收尾。
- KV有效命中不读D1、24小时绝对截止、迟到旧快照覆盖删除标记、D1故障返回503、并发续期与Cron条件重检，来自可控时间及故障注入的本地workerd测试。未在生产等待完整24小时、制造D1故障或跨节点旧快照覆盖，不把本地结果描述成全球传播实测。
- 图片／文件浏览器一年缓存策略保持不变；已下载或浏览器缓存副本不能撤回，未做长期浏览器复用实验。
- 云端正常R2上传、读取及已执行删除不能证明所有并发失败恢复边界；R2屏障竞态仍主要由本地测试覆盖。
- 本轮不重复宣称已验证Hermes、OAuth自然到期与所有跨节点传播。历史统计平台验收见[前次云端记录](2026-10-11-formal-cloud-acceptance.md)；本轮到期资源历史统计有新增本地回归及上述真实AE查询证据，但没有保留visits数值，未验证本轮访问量精确一致。
- D1备份不含R2正文，代码回滚不恢复数据；激活后保留实际T0与期限，失败时停留维护或使用保留期限语义的兼容版本。[恢复边界](../deployment.md#54-失败恢复与回滚边界)

Documentation impact：同步README、需求／设计当前状态、部署、文件与实现进度；保留已确认的产品要求，区分历史记录、本地程序证据与本轮生产观察。
