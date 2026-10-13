# Android 游戏指标 Rust 采集实施

日期：2026年10月13日。用户新增目标为参考 SonicCloudOrg/sonic-android-supply 与 Android 官方接口，用 Rust 实现游戏帧率、内存、CPU、功耗和温度采集，运行时不依赖 SAS 二进制。root 调用栈方向另做明确能力与符号资格，不把有 root 等同于完整符号化。FPS 与设备电气/温度已完成插件接线；本轮 Android 库 105/105、协议 141/141 通过，公共设备观测第一版已冻结并实现。新增公共层 Clippy 风格检查已最小修，相关包 Clippy、debug 构建、生成接口和新设备观测独立服务通过；root 调用栈尚未实施，真实游戏准确性未验收。

## 架构裁定

模式为 architecture-first，采用 Hybrid：先核公开来源、单位与归属，再以固定输出规则回归、真实服务和真机逐层验证。基础采样通过已有 Android 设备插件及性能会话完成；可选调用栈采样独立贡献、预算和产物。所有工具运行沿公开执行库的原绝对截止点、取消与清理，不扩大宿主平台分支。

选择 Rust 解析与采集适配，复用设备系统接口和合格 ADB。SAS 仅作方法参考，不作为生产可执行依赖；具体复用源码须先核许可证与固定提交身份。另一条路径是继续包装 SAS，当前用户已明确要求移除该运行时依赖，因此不采用。

| 单元 | 负责 | 不负责 | 输入、输出与副作用 |
| --- | --- | --- | --- |
| plugin-sdk 新性能观测类型 | 版本化纯序列化与固定单位 | 设备调用、真实性判断 | 插件样本的可选设备观测，无副作用 |
| domain 性能观测规则 | 边界、来源、单位与归属校验 | ADB、权限获取 | 纯观测到校验结果，无副作用 |
| Android 插件私有采集模块 | 游戏层归属、固定命令、输出解析 | HTTP、存储、宿主平台分支 | 受控设备读取到公共样本；有界进程与设备 I/O |
| application/infrastructure 现有会话 | 通用样本准入、历史与兼容映射 | 平台命令与传感器推断 | 可选观测原样存储，保持现有 CAS/代际与有限工作池 |
| frontend performance | 生成类型消费、严格字段/单位校验 | 页面、虚构指标、服务器路径 | 实际样本到插件公开数据；无新增 UI |
| 可选 rooted profile 插件贡献 | 有界 Perfetto/simpleperf 录制及真实资源收口 | 修改内核策略、自动打开权限、假符号 | 显式任务参数到有限 trace 产物，另行定义资格 |

拆分采集 I/O、纯解析、单位转换与来源选择；不向现有 session/performance.rs 塞入全部平台规则。生成类型只由主代理更新。性能专项/压测等全部业务完成后再做，本模块的指标功能检查继续并行。

## 首批口径

| 指标 | 观测与单位 | 归属与限制 |
| --- | --- | --- |
| CPU | 已有 proc 累计差分；总核占比与单核等价占比分别保留 | 当前主进程、同 PID/starttime/核数；首样本无有效差分 |
| 内存 | dumpsys meminfo 的 PSS/RSS，KiB | 当前主进程；共享页不能用 RSS 代替应用独占内存 |
| 游戏 FPS | 真实展示时间戳及帧窗口，宿主计算 frames×1000/duration_ms | 当前按包名边界与唯一候选层识别，尚未核 ownerPid/UID；丢锚、层冲突、未知/无新展示省略，不填零，不按定时间隔反推帧数 |
| 电池侧功率 | 已核电压/电流归一化后计算，明确 mW 与充放电方向 | 整机净电池估算；充电/外供电不能冒充负载功耗，不能标成单游戏功耗 |
| 温度 | 电池、CPU、GPU、机身等带传感器来源，明确 °C | 仅真实可读传感器；热状态不是温度，厂商名称与权限独立记录 |
| root 调用栈 | simpleperf/Perfetto 栈采样、线程与时间关联 | root 不能提供缺失符号；原生符号须 build-id 对应，Java/ART 支持按系统资格核对 |

不可用数据省略并明确来源资格，不以 0 伪造；采样权限不足不能升级为 root 已可用。首批保持原打开参数与十秒采样绝对预算；额外采集可以缺测，取消、超限、到期与未确认清理仍阻断。

## 新观测合同设计边界

现有 PerformanceSample、RawPerformance、PerformanceReading 的 CPU/PSS/RSS/FrameWindow 保持原含义。设备电气和温度应作为可选、版本化观测附加到样本，旧序列化省略缺省字段、历史不反填；SDK 与领域各自定义纯类型，由适配器显式映射，宿主不导入具体 Android 插件。设备来源与读取路线已核实，公共可执行字段已按本文件末尾第一版冻结并实现；生成类型由主代理在新构建后同步。

电气数据须同时带来源、观测时间、固定单位电压/电流、充放电符号规则、供电状态；未知电流方向不得派生功率，充电/外供电不产生放电负载结论。设备温度数组须带真实传感器类别与名称、摄氏温度、来源和热状态，限定数量与字节数；不能把电池温度代替 CPU/GPU/机身温度。新接口明确 device 归属；按应用估算能耗、ODPM硬件轨能量及电池侧净功率必须分别建模。

公开校验必须覆盖未知版本、非有限数值、单位倍率、缺测、符号与供电矛盾、整数溢出、来源/传感器长度和观测时间窗口。真实存储回归覆盖旧样本读回、新观测原值持久化、暂停/恢复基线和来源卸载；前端只消费生成合同且不重造服务端测量。

## 已核官方来源

- [BatteryManager](https://developer.android.com/reference/android/os/BatteryManager)：电流与平均电流为 µA，正表示净充电、负表示放电；平均窗口由电量计决定。energy_counter 为剩余能量 nWh，不能当作已消耗累积值；不支持值需识别，不填零。
- [AOSP HealthInfo](https://android.googlesource.com/platform/hardware/interfaces/+/refs/heads/main/health/aidl/android/hardware/health/HealthInfo.aidl)：电压 mV、电流 µA、电池温度十分之一 °C。
- [Linux 电源类](https://docs.kernel.org/power/power_supply_class.html)：sysfs 电压 µV、电流 µA、能量 µWh、温度十分之一 °C；与 Android HAL 的倍率分别转换。
- [simpleperf 使用文档](https://android.googlesource.com/platform/system/extras/+/master/simpleperf/doc/README.md)：目标资格、调用栈和符号化能力按系统、调试/可分析声明及构建产物记录；root 并不能补全缺失的游戏符号。

SAS 源码固定提交 c3aef56f297bc20a73e2ba040928e1a7a8004270，后端已读24个Go文件。当前确认没有功耗/温度/simpleperf/Perfetto/调用栈实现；精确函数与来源证据交由独立取证文档补齐。

## root 调用栈能力范围（尚未实施）

用户希望有 root 时获得类似性能狗的深度分析。可实现 CPU 采样调用栈、火焰图、线程调度与掉帧时间关联；权限、展开信息和符号身份分别判定，不以取得 root 宣称完整商用品质或完整源码可见。

| 能力 | 实施路线与资格 |
| --- | --- |
| 原生 C/C++ 调用栈 | simpleperf 采样与展开；函数名需对应构建的符号，源码行另需调试信息。缺失时保留模块、地址和 build-id。 |
| Java/Kotlin 调用栈 | 按 simpleperf 官方的 Android/ART 版本支持解释、JIT、AOT；混淆后的原始方法名需对应 R8/ProGuard 映射。 |
| Unity IL2CPP | 按原生调用栈处理，分别识别 libil2cpp 与 libunity；C# 方法或源码恢复依赖对应生成代码、符号和调试资料。 |
| Unity Mono | 不套用 ART Java 栈支持；完整 C# 托管栈需 Unity/Mono 专用支持与目标构建验证。 |
| CPU 热点与线程等待 | 普通 CPU 栈解释在核运行的位置；等待或抢占另采调度与 off-CPU 事件，不能用 CPU 样本份额当全部耗时。 |
| 内存分配栈 | heapprofd 等独立采集说明原生分配来源和未释放量；不把它等同于 Java/Unity 的完整托管对象或 GC.Alloc 追踪。 |

Rust 插件负责设备能力探测、受控采样、原始 trace 与符号产物关联、解析和公开结果；采样引擎使用系统可用的 simpleperf/Perfetto。移除 SAS 依赖不要求从头重造 ART 展开器。采样率、目标进程和持续时间须有界，录制结束、取消与卸载必须确认设备端资源收口。只有取得实际时间基准映射，才把调用栈、调度与展示帧归到同一时间轴；不能直接混用设备 boottime、monotonic 与宿主墙钟。

- [Simpleperf 应用分析](https://android.googlesource.com/platform/system/extras/+/main/simpleperf/doc/android_application_profiling.md)：root 设备可分析任意应用；Java 支持随 Android/ART 版本变化，符号化需要匹配资料。
- [Simpleperf 命令参考](https://android.googlesource.com/platform/system/extras/+/main/simpleperf/doc/executable_commands_reference.md)：调用栈与 on/off-CPU 采样分别配置。
- [Perfetto CPU 分析](https://perfetto.dev/docs/getting-started/cpu-profiling)及[原生堆分析](https://perfetto.dev/docs/data-sources/native-heap-profiler)：CPU 栈与分配栈属于不同数据源，权限按设备实际探测。
- [Unity Android 符号](https://docs.unity3d.com/Manual/android-symbols.html)及[脚本后端](https://docs.unity3d.com/Manual/scripting-backends.html)：符号表、调试信息、IL2CPP 和 Mono 的资格分别记录。

## 最低验收证据

1. 固定输出与单位规则定点回归，通过后保留实际固定命令和预算证据。
2. HTTP/MCP及真实前端消费者、历史兼容、取消/卸载的独立服务报告，不借记合成数值为真机准确性。
3. 目标手机真实游戏对照：明确进程与展示层、帧窗口、PSS/RSS、温度传感器、供电状态；记录root与非root分别可读能力。
4. 深度分析单列实际trace与符号资格；符号缺失保留地址/build-id，不伪造函数名。游戏功耗归因须取得相应测量或估算模型证据，不以整机电池估算替代。

## 设备观测第一版冻结（2026年10月13日）

模式为 architecture-first，选择 Hybrid：版本化合同先行，纯单位/归属验证与存储回归随后，私有采集和前端消费并行，最后独立服务验收。选可选嵌套 device_observation；拒绝把电气/温度塞成无来源数值或在宿主调用Android命令。沿既有职责表实施，SDK与领域分别定义纯类型，显式适配；规则拆独立文件，旧JSON缺省不补值。

- PerformanceSample/RawPerformance 增可选 device_observation；PerformanceReading 保留它并新增可选 battery_net_power_mw。后者仅领域从合格有符号原值派生，正充电、负放电；单位mW，为整机净电池侧功率，不是游戏/负载功耗。
- DeviceObservation: api_version=1、scope=device、device_id、battery可空、temperatures数组（至多32）。各成员observed_at为宿主读取时间Unix毫秒，在样本captured_at前10秒内；容器至少一项真实观测，device_id与固定采样目标一致。完整提供者代次仍来自会话source，不复制到设备插件未知上下文。
- BatteryElectricalObservation: observed_at、source（1–80 ASCII字节标识）、access（adb_shell/root_shell）、voltage_uv（1–50000000）、current_ua可空（±100000000）、current_polarity（positive_charging/positive_discharging/unknown）、status可空（unknown/charging/discharging/not_charging/full）、supply_state（battery/external/unknown）。无电流须unknown；未知极性不派生功率。已知极性与充放电状态或battery供电矛盾时拒绝；external负电流可表示电池净放电，不冒充负载值。
- DeviceTemperature: observed_at、source、access、sensor_kind（cpu/gpu/battery/skin/other）、sensor_name（1–128 UTF-8字节、无控制符）、sensor_type可空（HAL原类型，0–64但排除BCL 6/7/8）、temperature_celsius（有限，-273.15至400）、status可空（0–6）。0/1/2/3必须对应kind，其他类型只能other；同source/type/name不得重复。采集器首批HAL仅0/1/2/3，电池备用type可空，不按名称猜类型。
- PerformanceAccess/PerformanceSourceDefinition/ProbeCapabilities 增可选默认false的device_observation声明；未声明却返回观测拒绝。capabilities仅为声明该能力的来源增加device_observation=true和device_observation/battery_net_power_mw指标；scope=main_process仍解释基础CPU/内存，嵌套scope=device单独解释设备数据。

Linux ABI要求current_now正充电、负放电，且先核同一uevent POWER_SUPPLY_TYPE=Battery，不把USB IBUS当电池电流。普通dumpsys battery不提供CURRENT_NOW；冻结/UPDATES STOPPED输出不作当前数据。sysfs与dumpsys电压倍率分别转换；HAL仅读Ready且当前段，NaN缺测，缓存和headroom不作温度。缺测省略，结构超限/取消/原期限/未确认资源仍失败。

写权：主代理公共SDK/领域、宿主适配及准入/历史、生成器与根记录；后端android-device私有采集/协议；前端performance纯消费/回归；测试独立服务脚本与冻结输入。必要证据为旧JSON兼容、新原值与派生功率持久化、错误单位/矛盾/归属/版本拒绝、功能取消和热卸载、实际HTTP/MCP与前端；真机准确性、商业工具等价及性能压测独立留缺口。

## root 深度采集后续设计裁定（未编码）

本节为可行性方案，尚未添加清单贡献或生产代码。模式为 architecture-first、Hybrid：先建立设备权限、工具版本、进程身份与远端清理资格，再录制原始栈；符号化、火焰图与掉帧关联另交付真实产物和验证。

推荐独立 `stack.probe` 与 `stack.record` 任务贡献，使用设备写锁、单独预算和受控产物权限；不把长录制塞入十秒 `performance.sample`，不修改既有样本或通用宿主路由。Rust 负责受控设备 I/O 与解析，simpleperf/Perfetto 作为采样引擎，SAS 不进入运行依赖。

| 单元 | 职责、输入输出及副作用 | 不负责 |
| --- | --- | --- |
| rules/stack | 有界输入、明确工具 feature、固定 argv、trace 结构和整数范围纯规则 | 设备调用、符号猜测、宿主路径 |
| session/stack | 原总截止点、PID/starttime 前后核对、唯一远端目录、原始 trace 和元信息发布；有设备/文件 I/O | HTTP 路由、伪造函数名、把CPU样本当全部耗时 |
| operations/config | 独立贡献薄接线及部署工具/root入口资格 | 业务请求自由 shell/工具路径、自动修改设备策略 |
| 独立协议/服务验证 | 手工原帧、真实假工具、远端资源与热卸载收口 | 商用等价、真机指标准确性、采集开销结论 |

首批候选为已 root 的 adbd UID0；部署 su 需明确固定方言与权限资格后再支持。root 不等于所有系统资格：不自动执行 adb root、setenforce 或改内核配置。探测固定 `id -u`、系统版本/ABI、simpleperf 版本、`list --show-features` 与记录帮助；声明支持和实际记录成功分别报告。

候选录制参数限定 CPU 或 off-CPU 模式、包名、1000–30000毫秒、1–200Hz（建议默认10000毫秒/99Hz），不接受任意event/argv/路径。simpleperf 录制使用明确 PID、cpu-clock、DWARF 展开与 monotonic 时间；off-CPU 须精确支持 trace-offcpu。记录限额与整个远端/本地文件硬上限分别校验，不能把工具 size-limit 当完整文件限额。

取消和热卸载必须核对设备端 simpleperf PID/starttime 真正退出，再确认远端目录清理。ADB直接进程退出及 exit-with-parent 不能代替远端退出证据；未确认返回 cleanup_failed 并阻断旧代重载。原始元信息保存工具/采样参数、PID身份、时间基准、SHA-256与字节数，`raw_only` 和未核符号状态明确可见。只有匹配 Build-ID/ABI/构建符号后才显示函数名，源码行另需调试信息。

掉帧关联需核设备 monotonic/boottime 与宿主墙钟的同步关系；单独调度事件没有完整用户栈，时间重叠也不自动证明卡顿因果。Unity IL2CPP按匹配原生符号处理，Mono需运行时支持，heapprofd原生分配不表示完整C#对象或GC.Alloc追踪。后续逐层验证输入/资格、原D/取消/超限、PID换代/远端资源、产物/热卸载，再取得真机游戏与符号证据；性能专项仍等全部业务开发完成。
