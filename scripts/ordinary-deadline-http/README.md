# 普通操作真实 HTTP/MCP 总期限验收

状态：本目录实现 LONG-HTTP 驱动，等待主代理统一语法检查与真实 debug/release 执行。未运行夹具、构包、安装、服务或测试，不把源码交接写成动态通过。

输入为后端《普通操作总期限第一批契约》与《普通操作真实长进程验收方案》。根入口只选择已有 `backend/target/{debug|release}/apk-server`；不编译，不运行 npm，不调用包生命周期脚本。默认免令牌，复用宿主 helper 显式传入当前 `process.execPath` 作为可信 Node 运行时；请求限流 10000 只是验收行为条件。

主代理在宿主构建和夹具检查后可执行：

```text
node scripts/ordinary-deadline-smoke.mjs
node scripts/ordinary-deadline-smoke.mjs --release
```

## 文件职责与复用

| 文件 | 职责与公开复用点 |
| --- | --- |
| 根 ordinary-deadline-smoke.mjs | 单宿主、空目录、阶段编排、finally 收尾与报告；仅接受可选 --release |
| client.mjs | 复用 device-provider 的 createClient；clientFor 可选独立 mcp URL；sharedJob/jobEvents 严格比较 HTTP/MCP 原文 |
| host.mjs | 复用 unified-discovery-smoke 已有宿主/关闭/端口 helper；保留实际 ChildProcess 和二进制身份 |
| packages.mjs | installFixtures 上传真实原 TGZ 并核对六项有效预算；verifyPackageBytes 核对结束后原压缩字节 |
| jobs.mjs | submit/terminal/cancel/verifyHistory；共享 Job、原 input、唯一终态与标准 PublishedArtifacts 解包 |
| matrix.mjs | verifyMatrix 的八 Job 流程；两长分支全部收束后才进入收尾 |
| control.mjs/wait.mjs | ready/release/事件/诊断、仅 signal 0 的实际 PID 观察、有限单调等待；不启动或杀夹具 |
| process-evidence.mjs | verifyProcess 区分协议2 EOF/终止与协议3匹配取消/清理；失败仅收集本轮已知 PID |
| evidence.mjs | 首失败请求、同记录 Job/request/logID 关联、真实文件身份及保留证据 |

只读导入 Galileo `../ordinary-deadline/fixtures.mjs#createFixtures`；不复制 TAR 构造器，也不修改旧客户端或夹具。构造器返回的原压缩 SHA256 与本次实际上传 Buffer 严格相同。SDK request_operation 使用短名，公开 operation 使用返回的完整 ID；业务 input 只有 `{case_id}`。

## 八 Job 最小矩阵

| 场景 | 提交/取消入口 | 核对结果 |
| --- | --- | --- |
| L2 | HTTP 提交 | 协议2长声明120000；实际 ready 后驱动保持至少61000ms，超过60000ms仍Running/PID存在/宿主未重启；release后Succeeded |
| L3 | MCP 提交 | 同L2但协议3；与L2并行，分别计算自己的驱动和夹具单调时间，不相减跨进程计数 |
| S2-D | HTTP 提交 | short=10000、不release；Failed且error精确“执行超时”；实际直接PID消失，不要求强杀进程伪写exit/诊断 |
| S3-D | MCP 提交 | 同短D；匹配cancel的reason严格timeout、command/id一致；cleaned/响应/EOF/零退出自报及实际PID消失分别核对 |
| S2-C | MCP提交、HTTP取消 | ready后在短D内主动取消；Cancelled/error=null/result=null；协议2仅证明EOF与直接PID退出 |
| S3-C | HTTP提交、MCP取消 | 同主动取消；严格reason=cancelled及协议3匹配清理证据 |
| M2 | HTTP 提交 | default省略声明，目录公布60000/source=default；即时有限标准响应成功 |
| M3 | MCP 提交 | 同M2但协议3 |

全部八项均交叉 GET/工具读取同一个 Job 原文与事件；原 operation/input/id 不变，唯一终态事件，空存储 history 恰有八个 Job。每个 case 恰有一项 ready，八个不同 request_id；记录实际 PID 数和逐 Job/request/PID 对应，不把 PID 数推为进程树证明。协议2强制终止时受控 resource 可以残留，原件保留且不冒称合作资源清理。

## 时间、响应与清理边界

长分支先观察真实 ready，再等待本侧驱动单调时间超过60秒，交叉采样同Job Running及本次直接PID/宿主句柄仍在；至少61秒后才写UTF-8内容1放行。成功结果还独立核对夹具同进程 ready/completed 单调差与 elapsed_ms。该墙钟观察证明真实执行跨旧60秒窗口，不能证明成功资格线性化或性能。

short 的生产预算仍是10000ms，脚本观察窗口只负责等待原期限和清理后的公开终态，不延长生产D、合作1250ms、终止500ms或宿主原10秒关闭上限。ready限时8秒用于短场景，长/default为12秒；PID消失观察2秒。主动取消必须在驱动提交起算的短预算内发起，并通过实际控制reason再次核对分支。

协议2/3真实ProcessPlugin返回 `{result,artifacts:[]}` 的 PublishedArtifacts 领域包装，脚本固定解包该已核对端口，不能将任意业务wrapper当宿主产物。协议3源码对共享D已到期的外层token选择timeout；本批必须动态观察 S3-D 的线上timeout，源码和旧定向测试不替代当前Application HTTP/MCP包运行。

协议3成功/取消/到期核对夹具 cleaned、匹配response_written、stdin_eof和process_exit(code=0)；取消/到期还核对同进程收到cancel至零退出自报不超过原1250ms，并要求同Job/request的宿主“合作插件取消清理已确认”且cleanup=complete日志。实际PID不可见独立记录，OS退出码明确未采集；诊断outcome/标记/零退出自报都不能单独替代实际退出，更不能证明外部资源、真机事务或常驻会话。

## 报告、日志和失败复现

报告为 `artifacts/ordinary-deadline-smoke-{profile}.json`。宿主记录实际二进制执行前后SHA256；包记录上传的压缩字节SHA256及结束后原件身份。请求只保留方法、路径、状态、稳定code、log_id、场景/Job定位，不保存请求正文、环境、令牌或任意响应正文。

正常shutdown与监听释放后检查所有响应log_id落盘。八个Job各要求同一条“插件调用开始”结构化日志含job_id、plugin_request_id、plugin_id与该提交log_id，记录文件/行定位；不把全部请求数称逐Job日志配对。另索引完整日志文件字节数/SHA256及正常宿主退出日志。

首次失败的阶段、请求、有限断言类别和在途请求快照不会被finally的shutdown覆盖。临时根、真实TGZ、ready/events/release/diagnostic/resource及日志在成功和失败后均保留，根内checkpoint保存当次报告快照；本脚本不删除证据。失败时先关闭本次持有的宿主，再观察已知夹具PID；已有helper若只能强制结束本次直接宿主，整轮仍失败，不结束未知PID或宣称全部资源确认。

本目录不验证真实npx、分发成员、浏览器或设备。后续真实npx应独立记录自己的原归档、shim/实际host身份、端口、同Job和进程证据，不能由这次在线上传安装替代；内部父D、存储池、队列、成功资格竞争仍关联独立应用/纯测试。
