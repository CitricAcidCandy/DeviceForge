# Android 游戏 FPS 独立功能验收

本目录独立于已经通过的设备电气/温度验收，不修改其入口或原始证据。只读复用宿主生命周期、实际前端性能工厂与原 OS 句柄探针；FPS 独立 `evidence.mjs` 严格关联后台会话与预期失败场景。Cargo、新包冻结和服务资源由主代理统一协调；本入口不构建、不启动共享服务、不执行性能压测。原生夹具已在授权后独立编译。

```powershell
node scripts/android-game-fps-smoke.mjs --help
node scripts/android-game-fps-smoke.mjs --frozen-input=新宿主冻结目录 --plugin-input=新Android插件冻结目录 --tool=本目录原生假ADB路径 --probe=OS探针路径 --profile=debug
```

## 路由与身份冻结门禁

`route.mjs` 已按主代理裁定与后端命令序列冻结：`-s ID shell -T dumpsys --proto SurfaceFlinger`，裸 AOSP 12 LayersProto 及精确 magic 的新包装协议；metadata key 1/6 的四字节小端 UID/PID 同处见证，候选自身 owner_uid 与目标一致，整真实 parent 链声明无冲突。前后 `/proc/PID/status` 要求四 Uid 一致，末 stat/starttime 或 UID 变化使整样本失败。父链根明确为 -1，不猜其他 layout；正式来源记录在该模块。`--help` 不要求冻结也不启动任何二进制。

固定输入计划包含共享 argv、每场景 argv 与顺序原字节输出；原生假 ADB 仅精确匹配计划，不执行任意命令。每笔先写当次 ready/argv/PID 门闩，工具与父插件原 OS 句柄取得后才 release。普通工具和父插件应正常退出；在途卸载被生产取消的工具允许非零退出但不得由测试强杀。调用上限 256、每固定输出最多 1MiB，超量须拆批或缩小矩阵，不用循环压测。

## 已验收矩阵

- 官方身份字段确认的唯一目标层，按真实展示时间戳形成精确帧窗口，领域 FPS 与前端消费一致。
- 缺层、无新展示、丢锚/未知归属、错误 PID 或 UID，不补 0、不接受伪同名层。
- 两个有效候选缺测，不靠包名推测前台或任意选层。
- 同 PID 的 starttime 换代或 UID 变化使整个样本失败，不跨进程身份复用旧帧锚。
- HTTP/MCP 与实际前端读取同一稳定历史；暂停/继续触发真实采样，SF 工具在途卸载后会话 Interrupted、目录撤销、旧原值保留和新代不可冒充旧来源。
- 全部响应日志与后台会话固定代次配对；宿主正常退出、监听释放、冻结包/原字节/前端副本身份稳定。

当前 14 个独立黄金场景已编码，原生夹具编译、Node 语法和帮助入口均已通过。初始 status 不可用只缺 FPS，进程 starttime/UID 变化拒绝整样本。没有前台判定规则，多个有效候选缺测，不能从包名证明游戏在前台。

## 本次真实服务证据

2026-10-13 最终 debug 独立服务目录为 `artifacts/android-game-fps-service-debug-ecddefa9-1065-41c2-a08c-e255ac72e928`：`report.json` 为 passed=true，17 项检查、15 个会话、194 个工具、2170 个响应日志 ID、18 对插件调用全部通过。宿主与驱动均实际退出 0，宿主正常关闭，监听端口 64501 已释放；61 项输入、冻结二进制、配置与实际前端副本在本轮前后身份一致。

已独立回读全部 194 份 `fixture/call-NNN/process.exit.json`，并与报告逐份比对：193 个普通工具退出 0，全部父插件与探针退出 0，唯一在途 SurfaceFlinger 工具由生产卸载取消后退出 1；全部 test_kill=false。日志终态为 15 个 ok、2 个 dependency_failed、1 个 cancelled。两个依赖失败仅允许绑定 starttime-reused/uid-reused 的已核 failed 会话、对应进程身份错误、零样本及完整起止配对；其余失败不接受。

冻结目录为 `artifacts/android-game-fps-debug-frozen-76bc294e-250c-4526-ac30-4d414dd5d8b6`，原生夹具为 `artifacts/android-game-fps-adb-fixture.exe`。宿主 SHA-256 为 `f768ab0fa6f5b99c459afc716aeb4b47b0addae880cf0c836bf8481fd97b641c`，Android 插件为 `db01b975494e4f54cc9691d1eb06de857fbb8800824b418d2a7d81738167a724`；具体字节与前后身份见本轮报告及冻结目录 `freeze.json`。最终报告 SHA-256 为 `5fdc4a76180a1c75ff06c06e0b1a92182d074d19ae7def8094ef64c268322967`。驱动实际 close 的 PID/退出时间与报告身份保存在 `driver-exit.json`。

两次失败原件保留，不改写为通过：`android-game-fps-service-debug-7b7ae62a-9390-4d18-b769-aef87ecd95ac` 是驱动两样本短间隔与 OS 观察门闩竞争，已把采样改为单样本、60000ms 间隔；`android-game-fps-service-debug-68d67ba7-2db1-433a-baae-3b87bb12dcda` 的 15 项功能已通过，但旧观测日志规则拒绝预期 dependency_failed，因此最终报告仍失败。后者修为 FPS 独立日志模块后，用相同冻结包另起新轮取得上述完整通过；未放宽生产退出要求。

## 证据边界

固定输入不是实际 Android/OEM、真机或游戏，不能证明真实 FPS 精度、前台关系、浏览器页面、商业工具等价、正式分发、跨平台或生产容量。实际前端工厂在 Node 执行，未进行页面视觉验收。本次为功能验收，性能专项按用户要求延后。已通过的设备电气/温度独立实服不重跑。
