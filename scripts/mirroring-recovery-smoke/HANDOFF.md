# 恢复验收交接

更新时间：2026-10-23 17:25，亚洲/上海。仅测试助理独占驱动；未修改生产实现、旧冒烟、共享文档或生成类型，未运行 Cargo，未访问 7031、系统 ADB/HDC 或真实设备。

## 最终受检版本

- 宿主：`artifacts/mirroring-auto-recovery-20261023/frozen-04/backend/apk-server.exe`，SHA-256 `085fe34cc8e73f0059b8b9fece02ed5e386d88547a8a0379bb6159f4568e0a04`。
- 投屏插件：`frozen-04/mirroring/deviceforge-mirroring-plugin.exe`，SHA-256 `c5e1db195d835006f32bd4d9501d6bf189629a103e7636505b595426ca63efd4`。
- 清单：同目录 `manifest.json`，SHA-256 `d71eedc65894d71ff638acccfef507491133dff474674be81c70a27475bba31f`。
- 生产页面：`artifacts/mirroring-auto-recovery-20261023/frontend-web-compact`，不是旧 `frontend-web-final`。
- 假工具：`artifacts/mirroring-recovery-tools-6f5e1acd-d868-4674-82cc-b1ed790e68ee/fake-adb.exe`，SHA-256 `1a09ed79b23204a0f42ad09bf69a06322c109301b6975defc28c6a214a8a815c`。
- 两轮受检输入及递归驱动摘要稳定，宿主、插件和驱动字节一致；精确设备命令沿用第二轮合同，第四轮没有放宽未知 shell。

## HTTP 与进程故障例

报告：`artifacts/mirroring-recovery-smoke-8f4a8b01-2620-4815-96c3-8d09212e74eb/report.json`。

`passed:true`，十六例全部通过，零失败、零待接入、零回收错误。包含不支持不能清风险、旧代次拒绝、活跃会话保护、显式与自动恢复同代重开、持续失败保留风险、恢复中拒绝新会话、外来 forward/PID 身份保护、A 成功/B 失败不清全局、遗漏及空覆盖、挂住恢复进程、真实 OS 租约债务、无台账旧资源空输入、排空后一次自动恢复。驱动自检另为二十二项通过，不与真实宿主案例混算。

所有响应日志 ID 均关联独占宿主 JSONL。十六个宿主正常退出零；二百四十八次工具调用及父插件、探针全部确认退出。原生租约持有者 PID63688、启动器 PID60308、探针 PID64888 正常退出。逐 PID、出生身份、命令和原句柄退出记录见报告的 `process_recovery` 与逐例 `tools`，不根据历史裸 PID 清理。

## 生产页面与恢复后 WebRTC

总报告：`artifacts/mirroring-recovery-smoke-823da512-cdbb-49ed-9307-9f1663802365/report.json`。

该总报告必须保持 `passed:false`，因为无设备入口仍有真实产品缺口，不能由两个已通过子场景覆盖。

- `explicit-recovery/browser-selected/report.json`：通过。真实生产静态字节、真实非空故障、一次恢复 POST、默认折叠、成功回归紧凑行、展开明细非空且剩余零、GET 重查通过；没有自动重放投屏或设备业务。恢复 POST 日志 `488dfb64-e35c-4849-bd5d-b41c53acb2c6`。
- `explicit-recovery/recovered-webrtc/report.json`：通过。同一宿主、代次及合成设备的恢复后真实浏览器 answer、streaming、视频轨道、三十帧显示及三十帧解码、release 与本地轨道停止；台账及模拟资源归零。观看端输入消息为零。打开日志 `832326bf-2d0e-45b9-bf34-38c47c77600e`，释放日志 `6ba9696e-293c-432d-b1f1-f03dac5ff586`。
- `explicit-recovery/browser-all/report.json`：失败。卸载本轮合成提供者、全新 profile、没有选择设备时，真实 `/#devices` 页面缺少 `section[aria-label="投屏恢复"]`，没有恢复 GET，失败原文为“真实恢复面板未装配”。定位时 `frontend/src/pages/devices/index.tsx:230` 仅在 selected 存在时挂载 DeviceScreen，需主代理修复父级入口。没有修改本断言或以组件测试替代。
- `explicit-recovery/log-correlation.json`：补充收尾日志关联，不覆盖原报告；四百零五个响应日志 ID 全部匹配，宿主正常停止。

WebRTC 使用真实生产公开工厂源码的独占 Vite 探针，不宣称静态生产构建已完成播放；媒体为 FFmpeg 合成，不证明 PTP、三星、音频、输入、三十秒长时、LAN/NAT 或正式分发。主代理真机轮次不得与本轮合并统计。

## 截图与视觉交接

只保存，不亲审。以下路径均相对于页面总报告所在目录，交主代理组织视觉子代理：

- `explicit-recovery/browser-selected/01-recovery-risk.png`：紧凑风险行，明细默认折叠。
- `explicit-recovery/browser-selected/02-recovery-confirmed.png`：恢复成功后紧凑入口。
- `explicit-recovery/browser-selected/03-recovery-details.png`：主动展开的完整核对报告。
- `explicit-recovery/recovered-webrtc/04-webrtc-decoded.png`：合成 WebRTC 已解码。
- `explicit-recovery/browser-all/03-recovery-failure.png`：无设备父级入口缺失。

## 早期失败与规则边界

- `9d5ee20c-3804-4b6a-bf55-f12b23abc934`：cancel 本身正确为 failed/process_exited，夹具误将历史 recovered 报告与新的风险状态一并拒绝。已经限制 freshReport 到本次 POST；GET 允许保留历史报告，有独立回归。
- 第二轮首次审计失败：假工具仍预期旧 LEGACY_AUDIT/absence 模板。独占模板已严格同步目录可读核对、PID,ARGS 及排除自身；未知 shell 仍拒绝。
- 早期 WebRTC：内部控制通道固定 control=true，而观看端禁用输入；假工具错误预期 false。现按 legacy/webrtc 分别精确匹配，真实接入额外 socket，没有放开触摸、键盘或剪贴板。
- `1f6c4e5b-ba85-4456-8e9e-b40cde49be8c` 的十五过一败：资源正确保持 blocked，夹具错误要求只读 list_attempts 不变。改为要求查询增加且每项资源、清理和删除次数不变，完整重跑后已过；原件保留。
- 第二、三轮间歇失败保留原 JSON/pending 与报告，未清除或修写。第四轮一轮全绿不能反推早期失败不存在，也不能宣称永不再发生 Windows 共享拒绝。

## 最终进程回收

页面宿主 PID69628、Edge PID70800/42236/57184、FFmpeg PID59032/64568 均正常退出零；六十八次工具调用、插件及探针均已确认退出，浏览器派生树为空，独占 Vite 与代理监听端口释放。HTTP 十六个宿主 PID53580/31876/4184/16316/47192/65236/29556/63380/70648/40472/59128/30736/47832/71176/59304/57796 全部正常退出零。

统一工具 session68521 已结束，驱动及父 PowerShell 句柄已返回。17:24:22 全系统按本轮制品路径、恢复驱动命令和独占浏览器 profile 核对，残留自有进程为零。未结束用户或主代理进程，未操作7031上的用户投屏会话。最终边界为：第四轮 HTTP/进程与有设备面板/合成 WebRTC 功能通过，无设备入口失败，截图视觉仍待审核。
