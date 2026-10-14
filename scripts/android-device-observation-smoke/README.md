# Android 设备电气与温度观测功能验收

本目录只验收 2026 年 10 月 13 日冻结的设备观测第一版合同。使用新构建的真实 Rust 宿主与 Android 插件、真实 HTTP/MCP、实际前端性能工厂及原生假 ADB 黄金文本，不执行压力测试或性能调优。

## 运行前提

主代理必须先完成当前源码的构建与冻结，宿主目录包含 `apk-server.exe`，插件目录包含 `deviceforge-android-device-plugin.exe` 与对应 `manifest.json`。清单要求协议 4、性能 API 2 和 `device_observation=true`。禁止将既有投屏、FPS 或旧采样二进制转计本批。

原生假 ADB 源码为 `fake-adb.rs`，仅使用 Rust 标准库；在具有 MSVC 链接环境的 Windows x64 命令行编译，不占共享 Cargo：

```powershell
rustc scripts/android-device-observation-smoke/fake-adb.rs -o artifacts/android-device-observation-fixtures/fake-adb.exe
```

输出父目录须提前创建。OS 探针可复用 `artifacts/harmony-screenshot-fixtures-20261012/process-probe-observable.exe`；入口会将输入与前端相对导入闭包复制到本轮独立快照并核 SHA-256。

```powershell
node scripts/android-device-observation-smoke.mjs --help
node scripts/android-device-observation-smoke.mjs --frozen-input=宿主冻结目录 --plugin-input=插件冻结目录 --tool=原生假ADB绝对路径 --probe=OS探针绝对路径 --profile=debug
```

`--help` 只显示使用说明，不启动宿主、插件或工具；运行必须显式给出四类输入。每轮使用独立 UUID 产物目录、临时监听端口、数据库和插件目录。生成数据及报告保留于 `artifacts/android-device-observation-service-<profile>-<UUID>/`，失败不删除原件，不覆盖其他批次。

## 验收内容

- HTTP/MCP 能力原文一致，基础 CPU/内存作用域仍为 `main_process`，嵌套设备观测作用域为 `device`。实际前端工厂消费声明、原值与历史。
- 同一 Battery uevent 电压 `4000000µV`、电流 `-500000µA`、正充电极性和放电状态；USB 外部供电下仍允许净放电。dumpsys 的 `4200mV` 与最大充电电流不覆盖该电气原值。领域净电池功率须为 `-2000mW`。
- 仅读取 HAL Ready 的当前完整温度段，CPU `45.125°C`、GPU `43.75°C`、skin `36.125°C` 保留类型、名称、状态和观测时间；NaN、缓存段和 BCL 不当作温度；电池备用 `31.7°C` 的类型为空。
- 缺测样本省略新观测与派生功率；冻结 `UPDATES STOPPED` 电池、未就绪 HAL 不补零。正常与缺省稳定历史经 HTTP/MCP 与前端比较。
- 温度工具门闩期间热卸载，旧会话变为 `interrupted`，工具目录撤销；新代重载可采集，原会话来源与已存原值/功率不改写。
- 每个直接工具先取得工具与父插件原 OS 句柄再放行；结束检查实际退出、禁止测试强杀计成功，宿主退出码为 0 且监听释放。后台插件调用开始/结束、会话与固定代次、每个响应日志 ID 均在正常退出后落盘。

`fake-adb.rs` 固定支持正常发现、主进程 stat、system stat、内存和空 SurfaceFlinger 层列表，并按合同输出设备观测。夹具工具目录上限 256；本验收不证明 FPS 准确性。日志按最多 256 文件、每文件 16MiB、总计 64MiB 读取，证据索引最多 8192 条且深度不超过 12，报告分批写入。

## 证据边界

黄金文本是合成输入，不证明真实 ADB/Android/OEM 输出、真实游戏准确性、实际传感器精度、商业工具等价或采集开销。实际前端模块在 Node 执行，不等同真实浏览器绘图、页面或视觉验收。原 OS 句柄只覆盖本次直接工具和父插件，不代表派生进程树或远端设备资源。便携快照不替代正式 TGZ/npx、registry、跨平台或另一局域网主机验收。电气/温度是设备侧观测，净电池功率不能解释为单游戏负载功耗。

## 当前执行状态

本批脚本的 6 份 `.mjs` 语法检查、`--help` 和自有差异检查均退出 0，原生假 ADB 元数据检查退出 0；主代理随后链接夹具并冻结新 debug 宿主/插件。

新 debug 实服首轮通过：`artifacts/android-device-observation-service-debug-03a1812b-453f-4d40-849b-f72fe8f6565d/report.json` 为 `passed=true`，6 项检查、4 个会话、45 个直接工具、313 个响应日志 ID 和 7 对插件调用；驱动实际退出码为 0，独立 `driver-exit.json` 记录原 child close。45 份 OS 退出原件均独立与报告核对，工具及父插件均已退出、探针退出 0、`test_kill=false`；门闩温度工具由生产取消。宿主正常退出 0、监听释放，冻结输入/快照及实际前端字节身份稳定。实服结果只按本目录独立 `report.json` 的 `passed`、实际检查数、工具退出和冻结身份记录，未执行的部分不得计为通过。性能压测按用户要求延后至全部业务开发完成后。

## OEM BatteryService 最小重放入口

新增 `oem-replay.mjs` 仅用于修后 debug 冻结字节的独立功能验收，不替代上面的完整设备观测矩阵。由主代理统一启动：

```powershell
node scripts/android-device-observation-smoke/oem-replay.mjs --frozen-input=修后宿主冻结目录 --plugin-input=修后插件冻结目录 --tool=已有原生假ADB绝对路径 --probe=已有OS探针绝对路径 --battery-input=artifacts/android-power-readonly-166736c4-8c12-485a-ab6b-fb2a3334a838/battery-service.json
```

五个输入均显式提供；JSON 原件及其 SHA 纳入输入冻结，重放 `stdout` 原 UTF-8 字节。空 uevent 只代表 sysfs 不可用，空 thermal 使电池温度来自 BatteryService；未复现真实 Permission denied 的 stderr/exit1，真实权限失败仍由既有只读原件证明。冻结配置、原生工具、前端相对导入闭包和重放字节前后核身份。

公开样本须为 `battery_dumpsys`/`adb_shell`、3887000µV、charging、external、电流缺值、unknown 极性、净功率缺值和 battery_dumpsys 的 battery 温度34.1℃；不从无单位 OEM current now 推算电流或功率。HTTP/MCP 历史与实际前端工厂消费精确相等，停采并卸载后历史不改写；记录每个工具与父插件原 OS 句柄、宿主exit0及端口释放。`driver-process-exit.json` 只记录自身实际exit事件，主代理另补原child句柄退出原件。

本轮编写仅静态源码核对；当前持久运行环境不提供可用的静态模块解析器，未完成可执行语法检查。未执行入口、node --check、编译、服务或真实ADB。主代理先做语法检查，等待合并Root来源修复后的新冻结包再启动；通过仅按本轮实际report及原件审计，不计真机新包验收或性能专项。

Root权限来源的小批入口为root-access-replay.mjs：使用显式冻结宿主/插件、已有profile原生假ADB与OS探针，只验证UID0/Simpleperf不可用和普通无Root两次无媒体短录制。权限来源必须贯穿真实Session、索引、ZIP及实际前端，纯映射回归或既有无环境观测normal批均不能替代。本轮执行结果由主代理原child句柄和新报告独立确认。
