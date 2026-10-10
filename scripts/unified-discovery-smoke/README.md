# 统一发现真实HTTP/MCP验收

当前状态：原版本已由主代理完成语法检查及真实debug HTTP/MCP验收，历史报告为 `artifacts/raw-http-debug-20261009-2102.json`，不代表本次新增协议1的执行结果。本轮仅解除 `inputs.mjs`、`raw.mjs`、本文三文件冻结，补RAW-T01-001；其余九文件和共享夹具不改。本轮尚未执行测试、构建或服务，静态检查和冻结摘要在交接消息登记；新增源码不能借用历史运行清单宣称通过。

本目录独占新增根smoke，不能修改 `../unified-discovery/` 的共享夹具。公开配置按真实wire读取：`input: "identity"`，target/result才使用 `kind`；不复制旧测试中错误的输入标记结构。

## 依赖接口交接

夹具作者提供本次TGZ实际字节、manifest、插件ID、协议版本、设备声明版本、显式平台、发现操作以及管理员控制目录。严格业务输入保持 `{}`；合法/坏原文、门闩和取消模式均由夹具控制文件选择。真实事件须能关联请求ID和直接PID，并区分启动、写响应、stdin EOF、合作清理确认及实际退出。

实际依赖为 `../unified-discovery/fixtures.mjs` 的 `fixture/control/events/started/cleaned/exited`；设备版本、平台、实际manifest和TGZ字节从返回值独立记录。较宽schema夹具只重新封装公开manifest，归档复用 `../device-provider/fixtures.mjs` 的公开 `archive`；HTTP/MCP复用既有 `createClient`，不复制TAR构造器或客户端。

运行命令由主代理统一执行：`node scripts/unified-discovery-smoke.mjs`，当前release重建后使用 `node scripts/unified-discovery-smoke.mjs --release`。不编译、不下载依赖，不使用旧二进制代表当前版本。

## 最小运行矩阵

| 验收项 | 最少证据 | 不作出的推断 |
| --- | --- | --- |
| refresh/direct discover/format2 alias × HTTP/MCP | 六次成功，各次Job增量恰为一，夹具实际执行恰为一；历史原入口与空输入；目录关联本次Job | 端点采样不证明注册或发布原子性 |
| 坏业务输入 | 精确400/invalid_input或MCP同code；前后Job、目录、执行事件相等 | 不把开始门禁之后清目录零进程的允许窗口当作坏输入 |
| API1/2/3与协议2/3 | 独立记录两个版本；缺失/null、合法特殊与未知原文、100/101 UTF-8字节及控制符 | 不以插件顶层版本推设备版本；不把模拟平台当真机 |
| 协议1×API3独立兼容 | Json裸数组成功、同Job原文/目录、独立旧数组；业务伪result/artifacts精确拒绝后恢复合法发现 | 不要求协议1产生宿主包装；EOF和夹具cleaned标记不表示合作清理确认 |
| format2旧数组 | 精确完整 `id/platform/state/model` 数组，同次原文与显式平台 | 不从业务JSON外形推断宿主包装来源 |
| 拒绝安装/加载 | 按实际失败来源分别检查部署或贡献残留 | 合法已安装包的profile加载失败不要求部署消失 |
| 取消/热卸载/历史 | 合作帧、实际直接PID退出、精确错误、历史终态与目录分开记录 | cleaned标记不等于进程退出；Succeeded不代表过去曾接受目录 |
| 同目录真实重启 | 首次正常退出；启动第二个真实Rust；持久历史相等、无历史目录复活、重新发现新Job | 不把内存对象重建称进程重启；不从历史恢复动作观测 |
| 审计与失败 | 当次宿主/TGZ摘要、全部响应ID退出后落盘、原失败请求、失败目录/日志摘要保留 | 不补造旧报告或已删除归档的摘要 |

坏manifest、公开设备schema或非法声明按真实安装验证路径精确断言；失败包无部署残留。合法manifest但宿主format2绑定的profile/API3/platform不匹配，独立检查load拒绝后HTTP/MCP均无该owner贡献/提供者/别名，已合法安装的部署保留。若实际安装/load路径与冻结裁定不一致，立即回流，不接受任意4xx或主动删包掩盖残留。

RAW-T01-001复用共享夹具已经支持的 `protocol: 1`，不增加API1/2全笛卡尔组合。独立 `protocolOne` 使用平台 `synthetic_raw_protocol_one` 与非预留别名 `legacy.discovery_raw_p1_a3`，不占用 android.devices/harmony.devices。它仅进入 `all` 的进程/包证据集合，不进入固定期望协议2/3包装的既有成功矩阵；真实在线安装和加载由 `raw.mjs` 的独立步骤完成。

最小四次调用依次为HTTP直接发现裸数组成功、MCP旧数组别名成功、HTTP refresh收到业务伪包装后精确502/dependency_failed、HTTP refresh恢复裸数组成功。各次均检查一Job/一真实request/PID，HTTP/MCP历史保留原入口和 `{}`，合法原文、目录与结果来自本次Job。拒绝不是安装失败：合法部署先加载，坏返回导致本Job Failed、整份目录撤销，不能把业务JSON外形升级为PublishedArtifacts。该步骤结束后卸载并删除本次协议1部署，保留历史与 `all` 中的进程证据，避免改变后续重启的owner集合；新增四个Job不放宽原历史少于200的断言。

协议1证据明确 `cooperative_confirmation: false`。共享夹具的cleaned仅是自身步骤标记；独立PID不存在、匹配request、响应写完、stdin EOF和零退出分别核对，不声明外部资源或进程树已清理。本项未覆盖协议1运行取消，也不把设备API3预算声明读取写成跨61秒行为证明；期限补证另分配后端测试写集。

## 报告层边界

`evidence.mjs` 复用公开客户端，只存请求方法、路径、HTTP状态、领域code、日志ID和时长，不记录业务正文或凭据。业务首次失败后保存原阶段和请求；finally的shutdown记录不得覆盖它。报告路径预定为 `artifacts/unified-discovery-smoke-{debug|release}.json`。

`host.mjs` 只运行已构建宿主，默认不传token且显式传本次Node路径。正常退出沿原10秒边界；最终清理只使用本次spawn返回的直接宿主句柄，不杀夹具或未知PID。成功后才允许删除已核对路径的本次临时目录；任一业务、日志或清理失败都保留证据。

`bindings.mjs` 按已冻结公开wire生成format2配置；`discoveryBinding` 与 `writeBindings` 可供主代理实际npx验收复用。该导出只负责配置字节，不在线安装、不推断API3资格、不执行插件。

`requests.mjs` 只使用已核对公开路由和MCP工具，导出三入口调用、坏输入拒绝、完整Job列表与HTTP/MCP历史一致性校验。Job列表显式要求少于公开上限200，避免以截断列表冒充零Job。refresh的合法generation是传输身份；伪业务generation不能用覆盖合法身份制造假用例，而通过非法input附加字段验证刷新薄边界。

direct/alias的历史成功和目录接受不是跨资源事务：检查步骤只等待本次 `discovery_job_id` 对应目录，不以GET最新目录冒充refresh的独立回执。该有界观测等待不调整宿主发现的30秒绝对期限；开始/接受竞争的精确窗口仍由受控应用与pure门禁覆盖。

MCP标准 `tools/call.arguments` 是 `Option<JsonObject>`，null或省略按SDK映射为空对象，不是领域坏业务输入；数组/字符串在JSON-RPC解码边界拒绝。HTTP覆盖null/数组/字符串的精确领域400/invalid_input；MCP领域只对坏object校验同code。协议层错误码未在本smoke实测，不猜测、不以任意4xx通过，也不把该项写成领域覆盖。

真实存储/时钟和开始/接受门禁窗口关联 `backend/crates/application/tests/unified_discovery.rs` 的24项公共集成及内部pure门禁测试，不由HTTP采样重复宣称证明。浏览器、同包npx、平台真机另由主代理统一验收。
