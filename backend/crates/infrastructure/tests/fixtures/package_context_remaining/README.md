# 剩余四包操作的公开 context 黑盒验收

状态：本组新增 22 个测试，交接前仅静态审阅，未编译、格式化或执行。使用第二批裁定的四个公开 context 端口及准确 `new` 构造器，不访问私有 worker；上一批 `package_context` 28 项和所有旧夹具保持冻结。

## 文件职责与复用

- `package_context_remaining.rs` 只装配测试模块。
- `mod.rs` 负责独立临时仓库、构造器、真实工具编译、公开调用、时钟及同一 PID 观测。
- `samples.rs` 生成固定输入和预设工具输出，期望 DTO、成员及正文不调用公共核心求值。
- `tool.rs` 是主代理执行测试时以 `rustc` 编译的自包含真实模拟进程，逐项检查 argv、实际副本原字节和本次输出路径。工具不是 Apktool、bundletool 或真设备。
- `deadlines.rs` 负责 18 个期限及取消测试；`outputs.rs` 负责 4 个 DTO、发布、下载与扫描对照。
- 只读复用 `../package_context/store.rs` 的 `ObservedStore/Delays/Gate` 以及 tool-process 的 PID 存在性探测。不复制这些门闩，不修改旧文件，不向未知 PID 发送信号。

## 22 个测试的精确断言

| 编号 | 公开流 | 时间点与门闩 | 精确结果与副作用 |
| --- | --- | --- | --- |
| P01–P04 | build/decode/scan/extract 各一项 | 合法种子与配置完成；传过去 1 秒的 std D | 仅 `Error::Timeout`；download/put/发布计数均 0，工具启动、ready、argv、响应和退出意图标记均无 |
| P05–P08 | 四流各一项 | D 尚余 30 秒，调用前 token 已取消 | 仅 `Error::Cancelled`；download/put/发布均 0，零工具证据 |
| D01–D04 | 四流各一项 | 真实种子 I/O 完成后 pause；原 D=60 秒；download 在返回副本前挂门闩；推进到原 D | 门闩内确认原 D 未变及 download=1；仅 Timeout，put/发布=0，零工具；终态后放行门闩也不补跑 |
| T01–T03 | build/decode/extract 各一项 | download 门闩消耗宿主 45 秒后放行；真实工具原子 ready 且同一 PID 仍活；原 D 只余 15 秒 | 仍传同一原 D；推进到该 D 后恢复正常时钟等待清理；仅 Timeout，独立探测同一 PID 已退出，put/发布=0，未写工具响应 |
| C01–C03 | 三个有工具流各一项 | 真实 ready 后推进宿主 50 秒，原 D 尚余 10 秒时主动取消 | 原 D 不重置；仅 Cancelled，同一 PID 实际退出，put/发布=0，未写响应 |
| O01 | build | default/universal 分别独立根、工具 ready→release | 完整 DTO：source、mode、artifact、apk_count、universal_entry；artifact 名 built.apks；下载 APKS 原字节与预设工具输出全等，元数据/size/SHA256 对应；每子调用独立 PID 退出和一次 put/发布 |
| O02 | decode | 独立工具 ready→release 才生成必要成员 | 完整 DTO、6 文件数及正文总量；decoded.zip 所有成员与独立 resource/smali 原字节全等；同一 PID 退出，一次发布 |
| O03 | scan | 固定合法反编译 ZIP，五条规则直接公开扫描 | 完整 findings：指定类、内部类、缺类、包规则、前缀邻居不误报；证据排序与字段精确；download=1、put/发布=0、无工具 |
| O04 | extract | 合法 DeviceSpec，真实工具 ready 时读回实际 camelCase spec→release | 完整 DTO、排序 apk_entries；selected-apks.zip 两成员与固定结构 APK 原字节全等；下载元数据/size/SHA256；同一 PID 退出，一次发布，不连接设备 |

计数只观测被测 ArtifactStore 的 download、put 进入和实际发布完成；种子上传及验收下载走 `inner`，不混入这些计数。不把此计数表述成所有存储函数均零调用。

暂停 Tokio 时间仅证明宿主原点与扣时，不证明工具真实运行了 45/50/60 秒。等待真实 I/O 的观测任务持续 yield，避免暂停时钟自动推进。到数学 D 先精确 assert，再推进 1 毫秒供定时器刻度唤醒，不改 context 或生产预算。运行取消留 10 秒余量以免短窗口调度把先取消误测成到期。

30 秒墙钟看门狗只防卡死；真实 PID 退出的 10 秒观测上界只是独立验收等待，不替代公共工具清理的两秒预算。ready/response_written/exit.code 只是进程自报，不单独证明退出；取消、到期和正向均独立探测本次实际 PID。失败时只通知本次 release，保留临时根，不强杀未知进程、不宣称派生树或外部资源全部清理。

## 明确保留的边界

- 没有公开确定性路径触发真实 CleanupFailed，本组不伪造该变体，也不以非零/Timeout/取消代替；具体传递、monitor 与 tool 单次两秒并行收口由后续定向验收补。
- 未覆盖容量 close/spawn 竞争、私有 Pool 四槽、Future Drop 后许可/lease、owner 隔离及 Split extract 未确认对 install 的风险传播；这些不由 22 项成功反推。
- 本组不证明同步扫描/打包中途或 put 等待的独立时间点、不证明 None 的真实 120 秒旧限额、不证明 Some(D)>120 秒不截短。当前准备→工具链的同 D 证据不能扩大为每阶段全部通过。
- 不执行 Application Job/HTTP/MCP/browser/npx，不连接真设备，不计七操作独立插件迁出或宿主完整 shutdown/产物 staging 排空。

由主代理在输入冻结后统一运行：`cargo test --offline --locked -p apk-infrastructure --test package_context_remaining`，并执行所属 fmt、Clippy 与全门禁。代理交接只含新增文件静态清单，不把未执行写成通过。
