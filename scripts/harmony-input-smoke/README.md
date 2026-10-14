# Harmony输入真实宿主验收驱动

独立HTTP/MCP驱动固定十二贡献、十一声明能力、九设备availability。四动作各覆盖能力路由、插件贡献及平铺别名的两类公开入口，手写平台argv和资格档案，复用真实原Job、事件、旁置HDC配置及OS等待句柄。

入口为scripts/harmony-input-smoke.mjs，必须显式提供绝对冻结snapshot-root、tool-binary、probe-binary。snapshot包含backend/target/debug或release下的apk-server、deviceforge-harmony-device-plugin、validate-plugin，以及backend/plugins/harmony-device下双manifest、aliases、README副本。每轮从冻结输入复制真实部署、假HDC，校验前后SHA并保留实际副本、配置、argv、回执、日志及父子OS退出原件。

    node scripts/harmony-input-smoke.mjs --case normal --snapshot-root <绝对冻结目录> --tool-binary <冻结假HDC> --probe-binary <冻结OS探针>

选择normal覆盖四动作三入口、严格输入零工具、动态资格、同设备串行/不同设备并行和干净新代及旧历史。cancel为version/help/action/enter四独立轮次；queued验证未知输入卸载同时取消排队且不补Enter；known验证客户端exit7且完整匹配远端帧时业务失败、cleanup complete及正常卸载。all独立执行全部七轮，当前尚未完整重跑修后版。release使用--release，不能由debug结果转计。

## 非零客户端修后实际证据

2026年10月12日修后独立debug known退出0：1轮、2Job、8工具，报告`artifacts/harmony-input-service-debug-8de3fb23-5627-4bcf-941f-f8f9c336231f/report.json`。严格回执、实际客户端OS7、原dependency_failed与cleanup complete成立；父子句柄终态、loaded无cleanup_failed、正常卸载与宿主正常退出/监听释放均通过。

本轮使用`artifacts/harmony-input-client-exit-frozen-debug-d2cf5e6d-fd75-4128-b587-060bc42ef516/identity.json`中的9个冻结输入及其fixtures目录工具。修后83项库、串行输入协议20项及全目标Clippy通过；原并行协议期限失败和下节旧known失败仍保留。旧六轮49Job/151工具不转计修后新版，本轮不计完整all、release、正式分发、真实HDC或真机。

## 修前版本实际证据

2026年10月12日当前debug三程序构建exit0，原件为artifacts/harmony-input-service-debug-build-20261012.txt。三程序、双清单、aliases、README及假HDC、OS探针源与实际副本SHA一致，冻结为artifacts/harmony-input-frozen-debug-20261012-155620/identity.json。

七个运行文件node --check、独立手写双清单/模式/绑定契约及限定git diff --check均exit0。随后用同一冻结版分别执行四命令，未执行一次all：

| 选择   | 实际退出 | 场景轮 | 插件Job | 工具 | 结论                                                             |
| ------ | -------- | ------ | ------- | ---- | ---------------------------------------------------------------- |
| normal | 0        | 1      | 38      | 113  | 四动作24入口矩阵、严格输入、资格、写锁、新代与旧历史、日志均通过 |
| cancel | 0        | 4      | 8       | 30   | 四阶段实际取消、零后续事件、父子退出、粘性draining通过           |
| queued | 0        | 1      | 3       | 8    | 活动输入卸载、排队零插件/零工具、不补Enter及历史保留通过         |
| known  | 1        | 1      | 2       | 8    | exit7完整远端回执被丢弃仍未通过，不放宽原确认oracle              |

通过范围为六轮、49个插件Job、151次工具。加独立已知缺陷为七轮、51个插件Job、159次工具，不能表述为七轮全过。汇总为artifacts/harmony-input-service-debug-summary-20261012.json，含四份报告路径。四命令冻结身份向量完全相同，每轮执行前后SHA稳定；每个自有宿主正常退出，监听释放，无兜底结束自有探针。

known实际客户端OS退出码7、插件OS退出码0；远端原帧完整匹配标识、action及status0。汇总保存原字节SHA256及实际目录，补齐协议首轮只保存正常退出计划7的边界。当前仍返回cleanup_failed、资源unresolved和不可重载draining，独立报告保持passed:false。

源码/模拟协议、真实服务、正式分发、真实HDC及真机输入效果分别记录。本批未执行完整协议、完整workspace/Clippy、release、正式包/CLI/npx、真实HDC或真机验收。本驱动不证明实际UI接收、商业系统支持、剪贴板恢复、性能或派生进程树清理。固定文本属于公开测试样例，不能用此驱动录入真实敏感文本。
