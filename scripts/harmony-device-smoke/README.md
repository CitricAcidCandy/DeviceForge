# Harmony 核心设备真实宿主驱动

本目录属于独立验收，只消费公开 HTTP/MCP、现有宿主及 Harmony 插件 binary，不导入插件私有解析器。主代理先冻结四贡献/三能力版本并统一完成构建、夹具编译与执行；文件存在、语法检查或协议测试通过均不代表真实服务通过。

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

新宿主无插件时四旧名及四新贡献在 HTTP/MCP 目录均缺失，提交返回精确 404/not_found，不建 Job、不启工具、无内置回退。实际 validator exit0/四贡献，公开 load 返回协议4/API3、四贡献/三能力的当前 owner/generation；三能力分别是 packages（device/read/30s）、app.install 与 app.uninstall（device/write/120s）。旧名由显式格式2 bindings 恢复，三能力 binding 均核 wrapped:true。

未配 HDC 产生一个精确失败 Job；公开路径的空产物上下文不能误拒。refresh/direct/alias 三类发现各执行 HTTP/MCP 一次，每次只产生一个共享 Job、一个工具，核固定 list targets、完整两设备目录、当前 generation 与本次 discovery_job_id；旧发现结果保留完整有限数组。重复 serial 整份失败并撤销旧目录，再重新发现恢复。

包列表及卸载各覆盖 HTTP/MCP 能力和旧 alias，共八个成功 Job；核真实固定 argv 与完整业务结果。HAP 安装覆盖 HTTP/MCP 能力和旧 alias，共四个成功 Job；实际工具读取私有 input.hap，保留独立副本并核输入原字节、输出显示名脱敏、完成后目录删除与 scratch 清空。源 HAP 只是独立任意字节，仅证明授权、传输、复制与宿主历史，不能计为可被真机安装的有效应用。

锁组以安装能力、卸载旧 alias、卸载 direct jobs 验同 provider/同 device 写锁，另一设备卸载并行；核真实工具启动/完成意图时间与门闩，不靠计时长短制造通过。安装在途取消及安装在途 MCP unload 分别观察工具/父插件直接 PID 不可见、私有目录删除和唯一 cancelled 终态。卸载后四贡献无回退，HTTP 重载更换 generation，旧代三能力和 refresh 在 HTTP/MCP 精确 conflict 拒绝、零 Job/零工具，新代重新发现。任务原文、事件及源 HAP 下载原字节在卸载、重载后保留。

成功共 28 个 Job、27 次真实假 HDC 调用；未配 HDC 的失败 Job 没有工具。每个 Job 的 HTTP/MCP 历史与事件须逐项一致并只有一个终态，正常退出后逐 Job 关联真实宿主日志中的 plugin_request_id 起止及 submit_log_id。所有响应日志 ID 须落盘，自有宿主正常 exit0、端口释放、冻结输入前后字节稳定。

## 文件责任与原件

| 文件 | 责任 |
| --- | --- |
| 根入口 | 参数、冻结输入、串行编排、自有宿主、报告与有界清理 |
| deployment | 双 manifest、四 alias/三能力、便携描述、当前 binary、validator 与身份复核 |
| bootstrap / discovery | 目录、owner/generation、缺配置、三发现入口与失败恢复 |
| fixtures / fake-hdc.rs | 每调用独占门闩、实际 argv、父插件路径、直接 PID、HAP 副本 |
| jobs / actions | 同 Job 历史事件、准入精确错误、普通业务及旧 alias |
| artifacts | HAP 上传下载、私有副本、共享设备锁、安装取消 |
| lifecycle | 在途卸载、旧代拒绝、换代重载、历史与输入产物保留 |
| evidence | 实际 imports 输入摘要、逐 Job 日志、独立报告与原件索引 |

每轮报告写入 artifacts/harmony-device-smoke-{debug|release}-{run_id}/report.json。临时原件始终保留，首次失败不会被后续清理错误覆盖；标准输出只含通过状态、路径、首失败阶段、断言标签与错误类型。

## 证据边界

只证明当前回环真实宿主、独立 Harmony 插件进程、公开协议、固定 HDC argv、直接 PID、HAP 副本原字节、共享设备锁与生命周期；不证明真实 HDC、共享 daemon、派生进程树、真机、设备动作回滚、正式 TGZ/CLI install/npx/registry 发布、另一 LAN 主机或性能。completed 只表示响应写完后的退出意图；驱动另外核 PID 不可见，未取得工具 OS 退出码。目录端点采样不证明内部注册原子性，plugin_request_id 来自同 Job 日志，未截获插件 stdin 原帧。

当前实现尚待主代理执行并回流报告，不能提前记为 debug/release 服务通过。
