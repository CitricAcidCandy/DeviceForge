# Android 游戏电气与温度采集实施

日期：2026年10月13日。私有采集沿已冻结的device_observation第一版，插件提供原值，宿主负责合格净功率派生、历史及前端合同。电气/温度属于设备观测，不宣称单游戏功耗或CPU/GPU物理结温准确性。性能专项与压测按用户决定延后。

## 固定读取链与职责

原CPU/PSS/RSS和FPS保持含义。游戏展示读取结束后、最终/proc/pid/stat身份复核前，追加三笔固定只读命令：

1. cat /sys/class/power_supply/battery/uevent。
2. dumpsys battery。
3. dumpsys thermalservice。

每笔前缀固定为-s 原device_id shell -T，无自由参数、不获取root、不扫描其他节点、不修改系统。无游戏层路径共9笔；有合格展示窗口路径共12笔。全部共用原performance.sample十秒绝对期限、现有工具/worker租约、受限环境与直接进程回收。仅Dependency允许缺测；取消、到期、输出/结构超限和清理未确认必须传播，成功结果前仍核应用PID/starttime。

实现拆分为rules/environment的原值、battery/thermal解析和mapping，以及session/performance/environment的有界I/O。公共SDK、领域、宿主及生成合同由主代理维护；插件不计算净功率，不引入宿主平台分支。

## 电气资格与温度选择

同一uevent必须NAME=battery、TYPE=Battery，保留完整有界键值和原有符号µA；µV电压合格时优先作为单一电气来源。dumpsys只提供备用mV电压与0.1°C温度，不提供实际电流，不混合跨来源电压/电流，不使用Max charging current。present=false不产生电池观测，UPDATES STOPPED不作为当前状态。

Linux Battery ABI正充电、负放电；符合来源且状态/供电不矛盾时标positive_charging，矛盾或电流缺测标unknown并保留合格原电流。AC/USB/Wireless/Dock任一true为external，四项全false为battery，其余unknown。宿主仅从合格已知极性派生battery_net_power_mw，正充电、负放电，为整机净电池侧功率。

HAL必须Ready=true，且当前温度区段完整闭合。只接受0 CPU、1 GPU、2 Battery、3 Skin；类别由类型决定，保留名称和热状态，不按名称猜测。缓存、阈值、headroom、BCL及其他类别不作温度；单条NaN/非有限或非法记录缺测自身；重复身份或区段不完整整批缺测。已有合格HAL Battery时只抑制电池备用温度，其他HAL传感器保留；否则优先同合法uevent的电池温度，再用dumpsys。最终总计最多32项。

容器保留原device_id和scope=device。每个观测时点为宿主读取/解析返回后的Unix毫秒，须在captured_at之前十秒窗口内；来源标识固定为battery_sysfs_uevent、battery_dumpsys、thermal_hal_current。无电气且无温度时省略容器，不伪造零值。


## 本批实际验证与冻结交接

Android冻结源码输入见根artifacts/android-environment-fe46c8b8-dcc6-4d87-9765-390a1981d79c-inputs.json，共74个Rust/清单/Cargo输入及SHA256；所属16文件定点rustfmt退出0。主代理真实Windows门禁使用有效MSVC环境，Android库105/105（0.02秒）、完整独立协议141/141（12.42秒），日志前缀artifacts/device-observation-gates-fa19a3a7-d2a8-4ecb-8c2d-fd975475880c。该组覆盖FPS、电气/温度接线及手工假ADB协议；不以旧89/133结果替代新批。

初始Clippy门禁退出101，先暴露公开SDK/领域及后续application/infrastructure的collapsible_if。主代理只合并相应条件，受影响规则定点复验后继续相关包all-targets Clippy -D warnings，最终退出0。接续日志前缀artifacts/device-observation-resume-a98e035f-fa4e-4eb0-9d0f-dfca8dc6e221，runner记录Clippy、宿主/Android插件debug build、原生假ADB rustc链接和generate各0；没有再次重跑105/141已通过组。相关application/storage各12项复验通过。

本轮debug输入冻结根为artifacts/android-device-observation-debug-frozen-1d628d04-2f8d-43c3-9c76-187ab45c9974，独立测试使用该冻结宿主/插件进行实服验证；本文件尚未收到实服终态报告，不计HTTP/MCP或热卸载通过。主代理后续workspace阶段的架构检查、6项架构测试、fmt、workspace Clippy与build各0，但workspace test在infrastructure已有text_process_timeout_and_running_cancellation、total_deadline_stops_the_real_tool两项失败（146通过、2失败），原日志artifacts/device-observation-stage-04ba5c93-840e-47d4-a85d-f49275599246-workspace-tests.txt；完整workspace不能写成全绿。

实际权限、OEM输出/单位、电池充放电、HAL报告值与游戏帧准确性继续真机独立验收。root调用栈、符号化、火焰图与掉帧关联目前仅方案讨论，未由本批实现。Release/npx与性能专项尚未计入本证据；性能专项按用户决定延后。
