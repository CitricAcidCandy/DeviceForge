# Android 游戏采集来源证据

日期：2026年10月13日。本文件记录实际读取的上游实现与官方接口，不表示新增指标已经实现或真机通过。公共合同裁定见 [Android游戏指标Rust采集实施](Android游戏指标Rust采集实施.md)。性能专项按用户安排延后，采集功能开发继续。

## SAS 固定来源与许可

参考仓库为 [SonicCloudOrg/sonic-android-supply](https://github.com/SonicCloudOrg/sonic-android-supply)，默认分支 master，本次固定提交为 `c3aef56f297bc20a73e2ba040928e1a7a8004270`。递归目录完整，实际读取全部 24 个 Go 文件、两份 README 和 LICENSE；结论只针对该提交。

[LICENSE](https://github.com/SonicCloudOrg/sonic-android-supply/blob/c3aef56f297bc20a73e2ba040928e1a7a8004270/LICENSE) 为 GNU AGPL 第三版，相关源码头注明第三版或后续版本。本项目独立依据 Android 公开接口实现 Rust 采集，不复制 SAS 源码，也不把 SAS 二进制作为运行依赖。

| 能力 | 固定源码与行号 | 实际方法及 Rust 边界 |
| --- | --- | --- |
| 命令贡献 | [cmd/perfmon.go:123–139](https://github.com/SonicCloudOrg/sonic-android-supply/blob/c3aef56f297bc20a73e2ba040928e1a7a8004270/cmd/perfmon.go#L123-L139) | 系统 CPU、内存、网络；进程 FPS、CPU、内存、线程。GPU 参数被注释，未提供功耗、温度或栈采样参数。 |
| 进程定位 | [process.go:48–64](https://github.com/SonicCloudOrg/sonic-android-supply/blob/c3aef56f297bc20a73e2ba040928e1a7a8004270/src/perfmonUtil/process.go#L48-L64) | 读取 dumpsys activity 并正则查包名和 pid；本项目保留既有 pid/starttime 双重身份核对。 |
| 进程 CPU | [process.go:36](https://github.com/SonicCloudOrg/sonic-android-supply/blob/c3aef56f297bc20a73e2ba040928e1a7a8004270/src/perfmonUtil/process.go#L36)、[371–384](https://github.com/SonicCloudOrg/sonic-android-supply/blob/c3aef56f297bc20a73e2ba040928e1a7a8004270/src/perfmonUtil/process.go#L371-L384) | 读取 /proc/pid/stat，用固定 HZ=100 和配置间隔计算百分比，首次给 0。Rust 保留原始累计计数及宿主真实差分，首样本缺测。 |
| 内存 | [process.go:67–117](https://github.com/SonicCloudOrg/sonic-android-supply/blob/c3aef56f297bc20a73e2ba040928e1a7a8004270/src/perfmonUtil/process.go#L67-L117)、[120–233](https://github.com/SonicCloudOrg/sonic-android-supply/blob/c3aef56f297bc20a73e2ba040928e1a7a8004270/src/perfmonUtil/process.go#L120-L233) | PSS 来自 dumpsys meminfo --local，RSS/VmSize 来自 /proc/pid/status，文本 kB。Rust 使用已核目标身份的 TOTAL PSS/RSS，明确 KiB。 |
| SurfaceFlinger FPS | [process.go:691–759](https://github.com/SonicCloudOrg/sonic-android-supply/blob/c3aef56f297bc20a73e2ba040928e1a7a8004270/src/perfmonUtil/process.go#L691-L759) | 先全局 --latency-clear，再模糊查包名并取首个层；取延迟三列的第二列求间隔。Rust 不清空全局状态，不模糊选首层，使用同一唯一层的两个快照及保留锚点。 |
| gfxinfo 回退 | [process.go:530–545](https://github.com/SonicCloudOrg/sonic-android-supply/blob/c3aef56f297bc20a73e2ba040928e1a7a8004270/src/perfmonUtil/process.go#L530-L545)、[641–681](https://github.com/SonicCloudOrg/sonic-android-supply/blob/c3aef56f297bc20a73e2ba040928e1a7a8004270/src/perfmonUtil/process.go#L641-L681) | SF 错误或 FPS≤0 后回退 HWUI 文本，按 16.67 ms、60 Hz 估算。不能据此声称覆盖 SurfaceView/Vulkan 游戏或高刷新率。 |
| 系统 CPU | [system.go:244–329](https://github.com/SonicCloudOrg/sonic-android-supply/blob/c3aef56f297bc20a73e2ba040928e1a7a8004270/src/perfmonUtil/system.go#L244-L329) | 读取 /proc/stat 并累加所有列；本项目只累计前八列，避免 guest/guest_nice 重复计入。 |

全部 Go 文件中未发现功耗、温度、Perfetto、simpleperf 或调用栈实现。SAS 是上述基础计数方法的参考，五项游戏指标和可选栈采样必须另行实现，不能把它描述为 PerfDog 完整替代。

## Android 官方指标接口

| 来源 | 已核口径 | 适用边界 |
| --- | --- | --- |
| [dumpsys 文档](https://developer.android.com/tools/dumpsys?hl=en) | gfxinfo package-name 和 framestats 提供 UI 帧时序；meminfo/procstats 区分 PSS、USS、RSS；batterystats 为 UID 统计和近似用电。 | 不以历史 UID 估算当实时单游戏电功率；不能把 RSS 解释成应用独占内存。 |
| [慢帧官方说明](https://developer.android.com/topic/performance/issues/render?hl=en) | 不使用 View 系统的游戏绕过 Choreographer；OpenGL/Vulkan 使用 Frame Pacing 机制。 | HWUI/gfxinfo 回退不能证明游戏真实展示帧率。 |
| [AOSP FrameTracker.cpp（Android 10 固定标签）](https://android.googlesource.com/platform/frameworks/native/+/refs/tags/android-10.0.0_r47/services/surfaceflinger/FrameTracker.cpp) | dumpStats 三列依次为 desiredPresentTime、actualPresentTime、frameReadyTime；第二列为实际展示时间，INT64_MAX 为未完成。 | 文本属于系统调试接口，OEM/版本可能变化；只接收已识别、严格递增、有锚的完整窗口，未知格式缺测。 |
| [BatteryManager](https://developer.android.com/reference/android/os/BatteryManager?hl=en#BATTERY_PROPERTY_CURRENT_NOW) | CURRENT_NOW/AVERAGE 在 API 21 引入，整数 µA；正数为流入电池、负数为净放电。ENERGY_COUNTER 是剩余 nWh；不支持可能返回 MIN_VALUE。 | 平均电流窗口由硬件决定；没有应用归属。MIN_VALUE、未知单位或方向不得变成 0 或 abs 后的负载功率。 |
| [HealthInfo.aidl](https://android.googlesource.com/platform/hardware/interfaces/+/refs/heads/main/health/aidl/android/hardware/health/HealthInfo.aidl) | batteryVoltageMillivolts 为 mV；batteryTemperatureTenthsCelsius 为 0.1 °C；batteryCurrentMicroamps 为 µA。 | 电池温度仅属于电池传感器；接口字段单位不能自动证明 OEM 任意 sysfs 节点符合相同符号约定。 |
| [PowerManager 热状态](https://developer.android.com/reference/android/os/PowerManager?hl=en#getCurrentThermalStatus()) | 热状态 API 29；热余量 getThermalHeadroom 为 API 30，值 1.0 对应严重限频门槛。 | 热状态和余量不是 °C；温度需具体传感器类型/名称/来源，不得把电池温度标成 CPU 或 SoC 温度。 |
| [Perfetto 电池与功率计数](https://perfetto.dev/docs/data-sources/battery-counters) | Android 10 引入电池计数与 ODPM；电池计数为整机净电流/电量，硬件及分辨率由制造商决定；ODPM 读取 IPowerStats HAL 的分电源轨能量。 | USB 接入可能观测到净充电，不能代表总耗电；ODPM 需要专门硬件，分轨也不能自动归属游戏进程。 |
| [Android Studio Power Profiler](https://developer.android.com/studio/profile/power-profiler?hl=en) | 官方 ODPM 支持说明列 Android 10/API 29+、Pixel 6 及后续 Pixel；可视化设备子系统用电并与应用行为关联。 | 系统版本合格不等于设备具备电源轨；root 也不能生成不存在的硬件观测。 |
| [Perfetto FrameTimeline](https://perfetto.dev/docs/data-sources/frametimeline) | 要求 Android 12+；该页面仍注明 SurfaceView 暂不支持。 | 不能直接替代本阶段游戏 SF 展示窗口，也不能仅凭 Android 12 宣称所有游戏帧已覆盖。 |

电压与电流具备已核单位、方向和同批观测资格时，可计算净电池侧功率：`mW = -current_ua × voltage_mv / 1_000_000`，保留符号和外部供电状态。该值表示电池净输出估算，充电时可能为负；不能对充电值取绝对值后声称整机负载或游戏功耗。外供电信息不完整、方向未知或时间不一致时省略功率。温度按传感器原始单位做受检转换，未知单位不猜测。

## 原生与 ART 调用栈

- [simpleperf 官方 README](https://android.googlesource.com/platform/system/extras/+/refs/heads/main/simpleperf/doc/README.md)：第 9–10 行列执行器 Android 5+、配套脚本 Android 7+；第 111–146 行区分 Android 版本、DWARF 与帧指针回溯。DWARF 对 ARM/ARM64 与 Java 更合适，但单样本栈上限和缺失回溯信息仍可能导致断栈。
- [Android 应用采样指南](https://android.googlesource.com/platform/system/extras/+/refs/heads/main/simpleperf/doc/android_application_profiling.md)：第 20–39 行说明 debuggable 应用、root 设备及 Android 10+ 的 profileable shell 资格；系统预装 simpleperf 与下载工具资格不同。第 84–104 行明确剥离原生库会缺符号/断栈，Android 9+ 可采解释、JIT 与预编译 Java，Android 7/8 只支持满足条件的编译 Java；Android 6 及更早不支持 Java 栈。
- [Perfetto CPU 栈指南](https://perfetto.dev/docs/getting-started/cpu-profiling)：通过 linux.perf 和 callstack_sampling 采寄存器、栈并进程外回溯；当前示例写明 Android 15+，user 构建要求目标 profileable/debuggable。不能仅检测 perfetto 文件存在就承诺 linux.perf 可用，较早系统须核实际数据源和权限。
- [Perfetto 符号化与反混淆](https://perfetto.dev/docs/learning-more/symbolization)：原生地址到函数/源码行需要同构建未剥离 ELF 或合格符号文件；匹配 Build ID，失配文件跳过。Java/Kotlin 名称恢复需要对应 R8/ProGuard mapping.txt。内核符号需录制时权限，用户态符号通常在宿主离线恢复。

root 只可能改变访问资格，不能补出被剥离的原生符号、缺失的 DWARF 或反混淆映射。采到地址/模块偏移、有函数名、恢复源码行和完整引擎托管栈是不同证据；simpleperf/Perfetto 原生或 ART 栈不自动表示 Unity Mono/C# 全栈。

## 最小兼容合同建议

基础采样保持现有 performance.sample 打开参数、十秒原绝对截止点、只读固定 ADB 入口及受限 worker。CPU/PSS/RSS 的原字段与单位保留；FPS 使用现有 FrameWindow，source 带固定长度层摘要，同层两快照必须保留前一锚点。多个游戏层、层切换、时间回退、丢锚、无新展示和未知输出均省略，不能填零。SF --latency-clear 不进入命令表。

设备观测作为 root 拟定的可选 device_observation 扩展：保留传感器来源、单位、充放电方向和外部供电信息，老插件省略时继续兼容。具体字段、默认值及单位以公共合同裁定为准，本取证文件不改 SDK。不可用指标缺测；取消、到期、输出超限和未确认清理必须传播，不能被可选采集吞掉。

栈采样独立任务贡献、预算和产物，候选输入为设备、包名、有界持续时间/频率、已确认采样方式；输出为 perf.data 或 pftrace 及资格/符号状态元信息。采样器仅选已合格设备系统 Perfetto/simpleperf；SAS 完全不参与运行。任务不自动 su、不修改 SELinux/内核限制、不重装应用、不启用持久权限或修改电池供电设置。获取 root、设备操作与真机执行由明确授权及实际能力决定。

本轮只完成公开来源读取、合同建议与私有规则准备。真机游戏 FPS、CPU/内存、放电与 USB 充电电气观测、各类传感器、ARM/ARM64 栈及符号化仍须分别验收。
