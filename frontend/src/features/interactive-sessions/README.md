# 交互会话基础消费

本模块消费宿主协议5的公开会话接口，提供终端基础用例，不创建产品页面、伪终端、程序选择器或插件SDK入口。

## 文件职责

- `types.ts`：索引生成DTO的只读视图、请求类别与快照。
- `rules.ts`：目录、身份、原字节、排他游标、分页几何、终态和收据的纯校验及副本冻结。
- `state.ts`：选择代次、独立请求通路、订阅、输入准入与晚到保护。
- `polling.ts`：可取消的轮询间隔，取消后回收定时器。
- `index.ts`：公开用例编排；HTTP工厂复用`shared/api/session-gateway.ts`与`ApiClient.call`。

## 公开入口

通过`createInteractiveSessions(gateway, options)`注入网关，或`createHttpInteractiveSessions(client, options)`使用既有v2客户端。每项异步用例都要求显式`AbortSignal`。

| 用例 | 行为 |
| --- | --- |
| `refreshDefinitions` | 显式刷新独立会话目录及修订；刷新开始撤销本代旧目录 |
| `refreshRecords` | 显式读取服务器最多8条保留记录，刷新开始清旧目录 |
| `open` | 只提交当前目录中已有操作及JSON对象参数，打开响应保留真实Opening记录 |
| `openTerminal` | 调用`plugin.terminal.open`，只提交部署命名的`profile` |
| `resume(id, signal, after=0)` | 查询原ID；可恢复已有排他游标，不重新打开会话、不回放输入 |
| `query` | 读取当前会话状态及原始completion |
| `readOutput` | 从本地游标读下一页，默认50块，页长1至100 |
| `pollOutput` | 显式轮询，耗尽Finished的剩余输出后结束；默认间隔100毫秒，可设1至60000毫秒 |
| `send`、`eof` | 发送不超过8192项的原字节数组或有序EOF，等待真实收据 |
| `cancel` | 显式请求服务器停止，接收Stopping或Finished，资源终态继续独立查询 |
| `remove` | 仅当前已观察为Finished时删除记录；删除不代表清理失败已恢复 |
| `snapshot`、`subscribe`、`clear`、`dispose` | 消费冻结快照、订阅或撤销本地选择及等待 |

终端profile只允许1至64字节的小写字母、数字、点、短横线或下划线，首项须为字母或数字。普通前端不提交程序、argv、目录或环境变量。其他操作输入仍由服务器公开模式裁定，本模块不复制JSON Schema引擎。

## 字节、身份与终态

快照保留原始stdout/stderr、真实sequence与字节数组，严格校验连续序号和每页`min(limit, output_sequence-after)`块数。空页的next_sequence仍等于请求after，不合成序号，不重新编码字节，不提供UTF-8展示；非法字节与跨块多字节编码均可原样保留。

选中身份包含id、operation、plugin_id、generation和created_at；同ID的错代次、错归属和错操作响应拒绝。并行停止与输出观测按单调状态合并，晚到Running页不会回退Stopping或Finished。原completion的outcome、cleanup、process_exited、sequence及failure完整保留；Finished不自动解释为业务成功或资源全部清理，Complete需直接进程退出，但不证明派生进程或远端资源释放。

服务器每会话保留最多16MiB及65536块。本地追加也检查相同上限；序号与目录修订必须为安全整数，不将已经失真的大整数当作有效游标。恢复非零游标时只保留本次之后读取的块，之前的输出仍归服务器保留。

## 请求、取消与输入收据

目录、记录、观测、输入和控制各用独立请求通路。目录刷新互不撤销当前会话；输出轮询与输入可并行。query、readOutput和pollOutput共用观测通路，新观测替代旧观测。输入和EOF共享本地串行准入，上一项收据未结束时拒绝下一项；不设置无限队列。

每类请求独立记录logs及errors，不用会话ID代替日志ID。轮询保留最后一次输出请求日志；定时等待取消也保留该日志。输入和EOF成功收据只证明公开提供者接受，不能证明子程序已经消费字节。

新打开记录的inputState为writable；恢复已有记录为unknown，因为公开查询没有EOF字段。成功EOF转为eof。输入或EOF失败、等待取消或停止请求转为uncertain，阻止自动续发；用户可明确恢复原记录后再决定下一项输入，服务器仍裁定是否已EOF。服务器返回Stopping或Finished立即撤销在途输入等待，晚收据不发布。

取消等待、切换会话、clear及dispose只撤销本地请求和订阅，不自动发服务器cancel，也不重开、重试或回放输入。输出轮询错误直接结束，不自动重试。下游忽略信号时仍及时结束等待，晚成功与晚拒绝均被消费。

打开响应失联时客户端可能没有服务器创建的ID；本接口没有客户端关联键，不能自动辨认本次记录。通过显式refreshRecords定位实际记录，再选择resume，禁止根据等待失败重开。服务重启后的旧ID可能不存在，失败保留空选择。清除或切换选择也不释放服务器保留记录；活动会话和记录容量仍由服务器裁定。

## 实际验证边界

定点Node测试覆盖注入式HTTP契约、双路原字节、分页几何、输入/EOF顺序、轮询、终态、取消、代次、晚到、订阅重入和销毁。TypeScript及架构检查通过的证据由本批交接记录列出。

这些测试使用注入传输或网关，不能替代真实Rust服务、终端子进程、HTTP/MCP、浏览器或分发验收。生成类型由主代理同步；完整generate:api、check、test、build及跨端真实验收仍由主代理统一协调。本模块没有产品UI、PTY/resize、真实程序执行、自动会话重连或资源修复证据。
