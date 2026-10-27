# 公开异步插件运行库

deviceforge-plugin-runtime 的核心依赖为公开 SDK、Tokio 与 JSON，不引用宿主领域、用例、存储或 HTTP。适用于每任务一个进程、需要在取消前执行自有资源清理的插件；不实现设备提供者、常驻 RPC 或业务规则。

Windows 标准流入口另依赖 windows-sys 的句柄与控制台接口。`serve_once`、`serve_once_with_context` 和 `serve_session` 在创建标准流传输、调用处理器前撤销三路标准句柄的可继承位，防止业务工具派生的常驻进程持有宿主协议管道并阻止 EOF。此准备不关闭或替换标准句柄，不修改帧、期限或清理声明；有效句柄准备失败则明确返回错误。可注入 I/O 入口不修改进程全局句柄，非 Windows 平台不执行该系统调用。`stdio_inheritance` 以仍存活的自有后代验证响应、管道结束及插件零退出，不代替外部资源清理验收。

协议 5 新增独立 `session` 模块与 `serve_session` / `serve_session_io`，一个插件进程承载一个交互会话，旧协议 3、4 的帧和入口不变。处理器接收 `SessionOpen`、`InvocationContext`、`SessionInput` 与可克隆 `SessionOutput`，返回原 `Execution`。有界二进制输入/输出、EOF、取消、连续序号、固定 C0 和真实清理等待见[会话模块说明](src/session/README.md)；此能力不等于多会话 RPC 或完整终端迁移。

serve_once(handler) 从标准输入读协议 3 Request，将请求与 CancellationToken 交给异步处理器。stdin EOF、取消或坏控制帧会通知取消；处理器先清理，再返回 Execution 与明确 CleanupOutcome。Execution::complete 只能在清理成功后调用，失败必须返回 Failed。标准输出仅写一份有界 CooperativeResponse，不使用它打印业务日志。

framing.rs 先限制缓冲再读取换行帧，请求 512 KiB、控制 4 KiB；响应 1 MiB，超大结果转为固定错误。serve_io 支持注入异步读写用于测试。主机断开后输出可能失败，但处理器清理先于输出。

协议3和4的末帧均按写入、显式刷新、关闭输出的顺序交付。部分异步输出（包括标准输出）关闭时不会隐式完成缓冲写入；必须先刷新完整换行帧，宿主才能在读取响应后关闭插件输入。刷新失败返回固定传输错误，不宣称响应已经送达，也不改写处理器的清理声明。独立response_flush测试以不会隐式刷新的输出验证交付和刷新失败两个行为；真实stdio与宿主验证另行记录。

协议 4 使用新增 serve_once_with_context / serve_io_with_context，处理器为 FnOnce(Request, InvocationContext) -> Future<Output=Execution>，旧入口与旧字段保持不变。解析请求后、发送 Ready 前固定本地单调点 C0；只接受一份严格 Start，将截止点固定为 C0 + remaining_timeout_ns。等待 Start 的耗时不会重新获得预算，0 表示到期；Start 前或到期准入时业务处理器零调用。Ready/Start 使用 SDK context 模型，两个握手帧分别不超过 4 KiB。

InvocationContext 可 Clone，deadline() 返回同一个 std::time::Instant，cancellation() 返回共享 CancellationToken，check() 返回 ContextError::{Timeout,Cancelled}，同时到期与取消时到期优先。运行中到期会通知取消并等待处理器真实返回；显式取消、EOF、坏控制或重复 Start 同样先收口再响应，晚成功改为错误，处理器的 CleanupOutcome 原样保留。运行库不自行延长宿主合作窗口，不丢弃已启动处理器来制造 complete；若调用方丢弃运行入口 Future，则没有成功清理响应，宿主仍须保留未确认风险。

context.rs 负责公开上下文与加法入口，context/transport.rs 负责有界握手和响应，context/execution.rs 负责首次调用预检与期限竞争。两进程没有共享单调时钟：C0 + 剩余预算允许保守提前到期，宿主仍以原 D 判定最终发布资格；不宣称精确同点、派生进程树排空或真机事务回滚。本批协议 4 代码与纯 SDK 回归已落盘，独立传输测试由测试角色提供，尚未执行格式化、编译、测试或真实进程验收。

样例见 ../../plugins/cooperative-demo；`cargo test -p deviceforge-plugin-runtime` 覆盖正确取消、EOF、坏/错配/超大控制、初始帧限制、晚到成功拒绝、清理失败及响应上限。实际外部连接是否释放由业务插件和真机验收证明，运行库只传递信号与声明。

会话入口的取消、满输入队列和输出失败均撤销新 I/O，并继续等待处理器真实 Execution，不改写 cleanup。正常结束排空输出后发送终态，取消丢弃未发送输出；半帧写入中断只报告传输失败，不向损坏流追加终态。终态在独立有界宽限内传输，失败不能证明宿主收到清理确认。本批实现冻结后由主代理执行独立测试与完整门禁；宿主代际/卸载、HTTP/MCP、前端消费和终端插件仍属后续批次。

2026-10-10末帧增量已取得独立验证：response_flush两项先红后绿；context_stdio在debug/release各两个顶层测试通过，每种模式覆盖协议3/4与直接/阻塞池拒绝共32轮真实子进程。输入在完整错误末帧到达后才关闭，随后子进程零退出并回收；单轮共用15秒期限、整组60秒看门狗。ordinary真实宿主扩展debug/release各21检查/53Jobs、runtime两模式、日志、生命周期、合作取消与settings提交未知两构建模式均通过。完整workspace门禁及最终分发的状态以根交接和runtime-response-flush报告为准；当前证据不认定历史AI超时的唯一根因，也不证明背压下新增本地传输期限或真实外部业务。

## 公共服务运行入口

services 模块新增显式协议 6 的 serve_once_with_services/serve_io_with_services 与 ServiceClient、ServiceHandle<I,O>。处理器仍返回 Execution；旧协议 3/4/5 入口和签名不变。服务引用 version 为非空精确字符串；调用经宿主双向帧，不引入宿主依赖或 HTTP。固定五秒握手、C0 原期限、取消清理与有界队列见 ../../docs/contracts/公共服务与协议第六版.md。新测试和两个独立示例的构建/运行由主代理统一验证，本轮不将历史测试转计为协议 6 通过。
