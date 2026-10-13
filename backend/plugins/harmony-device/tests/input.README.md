# Harmony输入独立原帧验收

cases/input.rs 手写协议4请求、四动作、资格档案、固定平台命令及响应预期。fixtures/input.rs 仅依赖标准库，从实际脚本取得随机关联标识后核对整条独立预期脚本；它不导入或调用生产规则、完成帧解析器及命令构造器。

本批覆盖严格三层封套、字段类型、坐标/速度/官方按键边界、UTF-8字节限额、文本设备端字面量、原生Enter2054、Start准入、原期限、版本/帮助资格、完成帧唯一末尾及关联、明确业务失败、各阶段取消/EOF/截止点和零后续事件。直接客户端使用真实PID等待句柄确认退出；标记文件只用作门闩和证据，不替代进程状态。

发现旧用例保留原八能力，并追加实际探测的input资格。128台边界刻意持有首version超过八秒资格启动窗口：已启动命令仍在原期限内完成，窗口到点不启动help或下一台；九能力保留，未完成资格显式不可用。假HDC维持原八调用硬限额，不为测试引入并发、独立租约或新清理预算。

主代理协调共享Cargo后执行定点：

    cargo test -p deviceforge-harmony-device-plugin --test protocol input:: -- --nocapture
    cargo test -p deviceforge-harmony-device-plugin --test protocol discovery:: -- --nocapture

2026年10月12日首轮input定点编译成功、exit101，19/20通过，测试阶段8.96秒。唯一失败为客户端计划正常exit7且已写出完整匹配远端终端帧：合同要求保留完成证据、业务失败但清理可确认，当前返回cleanup failed。首轮原件为根artifacts/harmony-input-protocol-first-20261012.txt，失败保留，不放宽断言或计为完成。

同批discovery定点exit0，7/7通过，测试阶段9.29秒，包含128台、200字节序列号和八秒资格启动窗口。原件为artifacts/harmony-input-discovery-first-20261012.txt。源码冻结为artifacts/harmony-input-tests-final-frozen-20261012.json，运行期间零SHA差异；原件摘要为artifacts/harmony-input-tests-first-verification-20261012.json。std-only假HDC独立rustc、限定rustfmt及git diff --check均exit0。本批未执行完整协议、workspace、Clippy、构建、服务或分发门禁。

模拟工具协议与真实客户端退出仍不证明真实HDC、设备输入效果、剪贴板恢复、宿主锁、HTTP/MCP、正式分发或真机验收；服务和分发由主代理后续排队。

同日独立服务驱动已运行同一冻结debug副本：六轮49个插件Job、151次工具通过，另已知缺陷一轮两Job/八工具保持未通过。汇总为根artifacts/harmony-input-service-debug-summary-20261012.json。其中known已用真实OS等待句柄保存客户端退出码7、插件退出码0，并核对完整匹配远端action:0原字节，补齐首轮协议的退出码数值证据；没有重跑或改写首轮19/20的历史。完整workspace、release、分发与真机仍待验。
