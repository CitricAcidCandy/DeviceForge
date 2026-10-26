# 投屏恢复独立验收

本目录仅负责真实宿主 HTTP、真实投屏插件进程、原生 fake-adb 和 OS 句柄探针的隔离验收。禁止连接真实手机、用户 7031/5173、系统 ADB/HDC；不构建宿主或插件，不占用共享 Cargo，不修改生产文件和旧冒烟脚本。

## 方案与职责

采用 `plan-and-build` 与合同驱动的混合验证：先验证 HTTP 形状、代次和禁止误清除，再验证真实进程、资源保护和恢复。已冻结的 HTTP 合同是验收边界，不扩充生产接口。选择导入既有只读辅助模块、复制需要调整的独占夹具，而不是修改旧驱动或用内存桩替代真实服务。

| 模块 | 职责 | 不负责 | 输入、输出与副作用 |
| --- | --- | --- | --- |
| 根入口、`options.mjs` | 参数、独立运行目录、串行案例 | 生产构建与部署 | 冻结目录到终态报告；只写新制品目录 |
| `http.mjs` | 冻结 HTTP 合同与请求定位 | 业务重试、原始消息归档 | 本机独占端口到状态断言；请求不自动重放 |
| `host.mjs`、`processes.mjs` | 独占宿主及工具的退出证据 | 用户进程、历史 PID 清理 | 子进程句柄到退出记录；只关闭本轮子进程 |
| `fixtures.mjs`、`fake-adb.rs` | 合成媒体、远端资源、故障注入 | 真实设备、宽松接受新命令 | 本轮计划到模拟资源文件及 TCP |
| `cases.mjs`、`recovery-cases.mjs` | 合同与行为场景 | 生产恢复实现 | HTTP、模拟资源到逐项结果 |
| `recovery-contract.mjs` | 插件恢复命令及台账交接门禁 | 猜测或清除未知格式 | 明确交接后启用；未交接不得计通过 |
| `evidence.mjs`、`self-test.mjs` | 摘要、日志关联与驱动自检 | 浏览器或真机验收 | 白名单记录到摘要；自检不冒充服务通过 |
| `fault-*.mjs` | 独立协议故障进程检验真实宿主 | 冒充生产插件台账 | 合成坏报告或挂住进程到保护断言 |
| `browser-*.mjs`、`product-bridge.mjs` | 冻结生产页面恢复面板、合成提供者与截图 | 真实手机、内存伪造接口、视觉结论 | 真实 HTTP 转发、独占浏览器与待审核截图 |

## 冻结合同

- `GET /api/v2/plugins/mirroring/recovery` 返回 `{log_id,data:{id,generation,supported,cleanup_failed,recovering,last_report}}`。
- `last_report` 为 `null` 或 `{status:"recovered"|"blocked"|"busy",coverage:"plugin",inspected:u32,remaining:u32,message,checks:[{resource,status:"confirmed"|"blocked"|"busy",message}]}`。
- `recovered` 必须 `remaining=0` 且 `checks` 非空、全部 `confirmed`；A 成功/B 失败不能清全局风险，覆盖声明遗漏、空检查和仍存活的挂住进程也不能清风险。
- `POST` 同路径，输入 `{generation,input:{device_id:...}}`，成功响应使用同一视图。
- 清单 opt-in 为 `recovery:{api_version:1,operation:"runtime.recover",timeout_ms:30000}`，恢复通过特殊协议 4 操作执行，不冒充普通任务。
- 驱动不预设未冻结的错误文案或不支持错误码；要求旧代次 409、不支持请求为 4xx，且风险与代次不变。

## 当前交接边界

先落地不依赖台账格式的四例：`contract-view`、`unsupported`、`stale-generation`、`active-session-busy`。其中未声明恢复的案例用真实清理故障产生风险，再证明恢复接口不能清标记。

另有两个不依赖生产台账的真实宿主边界案例：`invalid-coverage` 用公开协议 5 创建真实风险后，逐个通过协议 4 返回缺失/空/设备级覆盖、缺失计数、空检查和仍有剩余债务的报告；`hung-recovery-process` 输出合格报告后故意不退出。必须确认宿主保持风险、故障报告实际发出和原进程退出，不得把插件未启动误判为保护通过。这两例明确使用合成协议进程，不计为生产投屏插件的恢复成功证据。

首轮已经按 `recovery/ledger.rs`、`remote.rs` 和 `store.rs` 接入精确 owner、PID/start/boot、幂等缺失核对和全插件扫表合同，预期脚本独立固定在 `fake-contract.rs`，不动态导入生产模板生成期望。生产插件覆盖显式/自动恢复同设备同代重开、持续失败、恢复中抢占、PID 身份不符、外来转发与 A 成功/B 失败的全局覆盖。

当前夹具预期对应 `frozen-02`：首次打开先精确核对旧资源；全局枚举命令只接受 `devices`，其余设备命令保持 `-s <本轮合成设备>`。审计先确认目录可读且可进入，再用 `ps -A -o PID,ARGS` 排除审计进程自身。未知 shell 仍须拒绝，旧轮次须使用该轮保留的工具原件，不把新版模板反套到旧二进制。

共十六例。新增 `legacy-empty-global` 通过真实生产恢复进程核对无台账、无旧控制状态但有旧远端资源的空输入；必须阻断且资源、清理次数与删除次数不变，允许只读查询次数增加。`completion-recovery` 要求会话排空后的一次自动恢复自行完成，不借下一次打开或显式恢复触发。

`tool-lease-debt` 使用独立原生进程实际取得同一资源排他锁与插件共享进程锁；要求恢复 busy、风险保持、没有设备清理调用且不结束持有者；真实归还并确认原进程退出后再次恢复及同代重开。该例验证存活 OS 租约保护，不声称诱发了生产 ADB 终止失败；后端工具库的捕获/监督债务生命周期另由主代理的 OS 集成测试覆盖。它与恢复响应后进程挂住是两种独立反例，不能互相替代。

台账和旧控制状态均位于本例插件可执行文件所在目录，分别为 `.mirroring-resources`、`.mirroring-control`。只读取真实插件发布的台账并核对阶段、归属和远端固定身份，不凭空创建生产记录。缺少必需原生工具或未来合同未接入时仍输出 `pending_contract`、总报告 `passed:false`，不算通过。所有 shell 精确匹配，合同改变须更新本目录夹具而非宽松放行。

## 运行

主代理提供宿主冻结目录（`apk-server.exe`）与插件冻结目录（`manifest.json`、`deviceforge-mirroring-plugin.exe`）。新驱动不会读取或操作正在运行的预览服务。

```powershell
rustc --edition=2021 scripts/mirroring-recovery-smoke/fake-adb.rs -o <独立制品目录>/fake-adb.exe
rustc --edition=2021 scripts/harmony-screenshot-smoke/process-probe.rs -o <独立制品目录>/process-probe.exe
rustc --edition=2021 scripts/mirroring-recovery-smoke/lease-holder.rs -o <独立制品目录>/lease-holder.exe
node scripts/mirroring-recovery-smoke.mjs --help
node --test scripts/mirroring-recovery-smoke/self-test.mjs
node scripts/mirroring-recovery-smoke.mjs --frozen-input=<宿主冻结目录> --plugin-input=<插件冻结目录> --tool=<本驱动fake-adb.exe> --probe=<process-probe.exe> --case=contract-view
node scripts/mirroring-recovery-smoke.mjs --frozen-input=<宿主冻结目录> --plugin-input=<插件冻结目录> --tool=<本驱动fake-adb.exe> --probe=<process-probe.exe> --case=invalid-coverage
node scripts/mirroring-recovery-smoke.mjs --frozen-input=<宿主冻结目录> --plugin-input=<插件冻结目录> --tool=<本驱动fake-adb.exe> --probe=<process-probe.exe> --lease-tool=<lease-holder.exe> --completion-recovery=true
node scripts/mirroring-recovery-smoke.mjs --frozen-input=<宿主冻结目录> --plugin-input=<插件冻结目录> --tool=<本驱动fake-adb.exe> --probe=<process-probe.exe> --case=explicit-recovery --completion-recovery=true --browser-dist=<本轮冻结生产构建目录>
```

默认 `--case=all`，也可选单例；`--server-version` 默认 `3.3.4`，可选 `3.3.1`。拒绝未知、重复、空参数。不自动运行编译命令，不使用系统 adb，不隐式选择 target/debug 以免读到在途构建。

`frozen-02` 包含排空后自动恢复，必须传 `--completion-recovery=true`。持续失败的案例先等待这次自动尝试真实返回阻断，再调整合成故障并验证显式恢复，防止与自动收口竞态。成功案例不要求清理风险在中间瞬间常驻。

## 证据与进程收尾

每次创建全新 `artifacts/mirroring-recovery-smoke-<UUID>/`，保留宿主、插件、清单、假工具、探针及实际驱动依赖的 SHA-256；复制后及收尾再次核对，禁止覆盖旧失败报告。每例独立数据根、用户根、插件副本、配置、日志和端口，禁止新台账跨例共用。

总报告和逐例报告分开列出通过、失败、待交接。记录响应日志 ID，并在独占宿主 JSONL 中关联；不记录凭据、会话输入、输出、SDP/ICE 或任意错误正文。正常关闭必须宿主退出 0、工具及插件真实 OS 句柄退出、探针正常退出和端口释放。强制自退或强制结束自己的宿主/探针仅作失败收尾，不算通过；不根据历史 PID 杀进程。

## 后续生产浏览器验收需求

`--browser-dist` 仅允许搭配 `--case=explicit-recovery`。先完整通过真实插件 HTTP 显式恢复和同代重开，再制造一份新的可恢复合成债务，加载独立模拟提供者。页面由本轮代理按生产构建原字节提供，全部 `/api/` 原样转发真实隔离宿主，不替换请求或伪造恢复响应。

场景使用仓库现有隐藏浏览器助手，不调用或重启 CUA/MCP。当前生产输入为 `artifacts/mirroring-auto-recovery-20261023/frontend-web-compact`。实际从设备工作台发现并选择本轮设备，点击“核对并恢复”；验证风险默认折叠、成功后回到紧凑入口、主动展开后报告非空且剩余零、按钮复位和重查保留。网络断言要求仅一次显式恢复 POST、无自动 session/device-actions 重放。截图 `01-recovery-risk.png`、`02-recovery-confirmed.png`、`03-recovery-details.png`（失败时另留 `03-recovery-failure.png`）只保存、不亲审，报告 `visual_review` 保持等待视觉子代理。

同一非空故障经真实面板恢复后，用生产公开工厂源码在独占 Vite 与真实浏览器运行 WebRTC，要求 answer、streaming、视频 track、至少三十帧显示和十五帧接收解码、release 及轨道停止。Vite 缓存、浏览器 profile 和合成媒体均在本轮目录，不写共享前端缓存。此处明确是生产工厂源码探针，不声称静态生产构建已完成播放。插件内部视频通道使用 `control=true` 连接内部控制 socket，观看端仍禁用输入，驱动不调用触摸、键盘或剪贴板。

随后卸载本轮合成提供者，使用全新浏览器 profile 验证没有选择设备时的“核对全部投屏资源”。若产品父级未挂载恢复面板，该场景必须失败并保留 DOM 及截图，不能拿组件测试代替真实页面入口。FFmpeg、独占 Vite、隐藏浏览器与派生树、宿主、工具及探针均纳入收尾证据。

忙碌/阻断明细与日志 ID、旧代次不覆盖新视图、恢复中禁止重复开启等更多页面时序仍须扩展独立场景。HTTP 恢复成功和合成 DFML 不证明浏览器播放；合成 WebRTC 播放也不证明真机、声音、输入、长时稳定性、LAN/NAT 或正式分发。图片验收交视觉子代理，测试助理不审核图片。
