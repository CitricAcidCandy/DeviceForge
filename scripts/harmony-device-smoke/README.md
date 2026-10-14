# Harmony 核心设备真实宿主驱动

本目录属于独立验收，只消费公开 HTTP/MCP、现有宿主及 Harmony 插件 binary，不导入插件私有解析器。主代理先冻结十贡献/九定义能力版本并统一完成构建、夹具编译与执行；定义能力含七设备和二提供者，设备availability仍只含七项。文件存在、语法检查或协议测试通过均不代表真实服务通过。

## 主代理执行

在项目根目录使用已有同 profile 的 apk-server、validate-plugin 与 deviceforge-harmony-device-plugin：

```powershell
rustc --edition=2024 scripts/harmony-device-smoke/fake-hdc.rs -o artifacts/harmony-device-fake-hdc.exe
node scripts/harmony-device-smoke.mjs --tool-binary G:/Rust/DeviceForge/artifacts/harmony-device-fake-hdc.exe
node scripts/harmony-device-smoke.mjs --release --tool-binary G:/Rust/DeviceForge/artifacts/harmony-device-fake-hdc.exe
```

可通过 --source-directory 指定冻结双 manifest、aliases.example.json 与 README 的绝对目录。binary 仍取当前 backend/target 同 profile 的原件。脚本不运行 Cargo、rustc、npm 或打包器，不连接用户现有服务；使用回环临时端口、免鉴权、自有数据、部署与 scratch 目录。

Harmony 当前没有 package.json，驱动在独占临时目录生成最小便携描述供现有 CLI materializeManifest 消费，使用当前原 binary 与原双清单生成绝对入口清单；这不是正式分发包。部署者配置后置到 portable/bin/harmony-device.config.json，与实际 binary 同目录。配置不修改源清单、生成清单或 binary。

## 必须通过

新宿主无插件时十显式绑定及十短贡献在 HTTP/MCP 目录均缺失，提交返回精确 404/not_found，不建 Job、不启工具、无内置回退。实际 validator要求exit0/十贡献，公开load返回协议4/API3、九定义能力的当前owner/generation；七设备能力为 packages、app.detail（device/read/30s）以及 app.install、app.uninstall、app.start、app.stop、app.reset（device/write，安装/卸载120s，其余30s），connect/disconnect为provider/write/30s。既有绑定与新增两连接绑定均使用显式格式2，九能力binding核wrapped:true，不把新增名字当作已验证的旧宿主兼容。

未配 HDC 产生一个精确失败 Job；公开路径的空产物上下文不能误拒。refresh/direct/alias 三类发现各执行 HTTP/MCP 一次，每次只产生一个共享 Job、一个工具，核固定 list targets、完整两设备目录、当前 generation 与本次 discovery_job_id；旧发现结果保留完整有限数组。重复 serial 整份失败并撤销旧目录，再重新发现恢复。

包列表及卸载各覆盖 HTTP/MCP 能力和旧 alias，共八个成功 Job；核真实固定 argv 与完整业务结果。HAP 安装覆盖 HTTP/MCP 能力和旧 alias，共四个成功 Job；实际工具读取私有 input.hap，保留独立副本并核输入原字节、输出显示名脱敏、完成后目录删除与 scratch 清空。源 HAP 只是独立任意字节，仅证明授权、传输、复制与宿主历史，不能计为可被真机安装的有效应用。

锁组以安装能力、卸载旧 alias、卸载 direct jobs 验同 provider/同 device 写锁，另一设备卸载并行；核真实工具启动/完成意图时间与门闩，不靠计时长短制造通过。安装在途取消及安装在途 MCP unload 分别观察工具/父插件直接 PID 不可见、私有目录删除和唯一 cancelled 终态。卸载后四贡献无回退，HTTP 重载更换 generation，旧代三能力和 refresh 在 HTTP/MCP 精确 conflict 拒绝、零 Job/零工具，新代重新发现。任务原文、事件及源 HAP 下载原字节在卸载、重载后保留。

原四贡献历史保持 28 个 Job/27 次真实假 HDC 调用；新增应用矩阵另记三动作各 capability/direct/alias、HTTP/MCP，自动 ability 记录一 Job 两次工具调用、取消、失败和共享写锁。所有矩阵 Job 的 HTTP/MCP 历史与事件须逐项一致并只有一个终态，正常退出后逐 Job 关联真实宿主日志中的 plugin_request_id 起止及 submit_log_id。所有响应日志 ID 须落盘，自有宿主正常 exit0、端口释放、冻结输入前后字节稳定。

## 文件责任与原件

app.detail 为 device/read/30000，严格业务输入只含 bundle，固定 `-t <device> shell bm dump -n <bundle>`，返回完整对象而不包装为 detail/output，旧 alias 按 wrapped 提取同对象。详情成功矩阵共 6 Job，覆盖三入口双协议、完整未知字段、无 mainAbility 和精确标题；失败共 9 Job，覆盖错误标题、根数组、重复键、尾随、64 层/100000 节点限额、stdout/stderr UTF-8 和 stderr [Fail]。7 类非法输入 × 3 入口 × 2 协议为 42 个拒绝请求，均零 Job/零工具。同设备读取并行与 held 取消共 2 Job，换代后详情再记 1 Job；该既有矩阵保留83 Job/89 HDC。读取不获取既有设备写互斥锁，本轮不宣称读写互斥。

连接成功组在没有发现目录时执行新连接、重复连接和静默断开，三入口双协议共18 Job/18工具；每次核固定独立argv `tconn address` / `tconn address -remove`，localhost字面值保留，设备目录始终为空，不自动发现、改变目录或执行daemon/补偿命令。九种业务shape样本、两能力、三入口、两协议产生108个准入拒绝，加非null设备范围12个与direct缺显式封套8个，总128个精确400/invalid_input拒绝请求，区间零Job/工具。

数值资格与shape不同：`256.0.0.1:5555`、`127.00.0.1:5555`、`localhost:0`、`localhost:65536`可通过清单形状校验，四样本跨三入口双协议产生24真实失败Job；插件在配置与工具前返回固定输入错误，工具为零，不能把这些计作准入零Job。工具失败组另有12 Job/12工具，覆盖两能力的stdout/stderr失败诊断与未知目标、两流UTF-8、非零退出以及连接空响应/断开未知非空响应。

资源组新增provider屏障双向冲突设备读写与同provider串行7 Job/7工具、两能力在途取消2/2、网络独立在途卸载1/1和新代无发现断开1/1。原两代设备矩阵保留，网络再独立装卸两代并核旧代两能力HTTP/MCP精确conflict拒绝。全部新增共65 Job/41工具，当前总库存要求148 Job/130工具（87成功、50预期失败、11取消）。事件数量逐Job回读，并由独立SQLite审核取得实数，不凭Job公式转记证据。查询使用公开`limit=200`并要求少于200，假工具目录看门狗上限200；仅调整独立驱动库存边界，不改变生产期限或资源限额。

| 文件                                                       | 责任                                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 根入口                                                     | 参数、冻结输入、串行编排、自有宿主、报告与有界清理                                                 |
| deployment                                                 | 双 manifest、十绑定/九定义能力、provider/device作用域、便携描述、当前 binary、validator 与身份复核 |
| bootstrap / discovery                                      | 目录、owner/generation、缺配置、三发现入口与失败恢复                                               |
| applications / application-resources / details / inventory | 详情、启动、停止、重置、自动ability、严格失败、取消、读取并行、共享写锁及逐矩阵Job/工具库存核对    |
| fixtures / fake-hdc.rs                                     | 每调用独占门闩、实际 argv、父插件路径、直接 PID、HAP 副本                                          |
| jobs / actions                                             | 同 Job 历史事件、准入精确错误、普通业务及旧 alias                                                  |
| artifacts                                                  | HAP 上传下载、私有副本、共享设备锁、安装取消                                                       |
| lifecycle                                                  | 在途卸载、旧代拒绝、换代重载、历史与输入产物保留                                                   |
| network                                                    | 无发现提供者动作、两类输入失败边界、固定命令/结果、双向provider屏障、取消和独立网络装卸            |
| evidence                                                   | 实际 imports 输入摘要、逐 Job 日志、独立报告与原件索引                                             |

每轮报告写入 artifacts/harmony-device-smoke-{debug|release}-{run_id}/report.json。临时原件始终保留，首次失败不会被后续清理错误覆盖；标准输出只含通过状态、路径、首失败阶段、断言标签与错误类型。

## 证据边界

只证明当前回环真实宿主、独立 Harmony 插件进程、公开协议、固定 HDC argv、直接 PID、HAP 副本原字节、共享设备锁与生命周期；不证明真实 HDC、共享 daemon、派生进程树、真机、设备动作回滚、正式 TGZ/CLI install/npx/registry 发布、另一 LAN 主机或性能。completed 只表示响应写完后的退出意图；驱动另外核 PID 不可见，未取得工具 OS 退出码。目录端点采样不证明内部注册原子性，plugin_request_id 来自同 Job 日志，未截获插件 stdin 原帧。

当前实现尚待主代理执行并回流报告，不能提前记为 debug/release 服务通过。
