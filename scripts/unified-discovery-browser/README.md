# RAW-BROWSER 独立生产浏览器验收

本目录依据后端 [统一发现第二批契约](../../backend/docs/统一发现第二批契约.md) 和前端 [统一发现发布回执消费边界](../../frontend/docs/统一发现发布回执消费边界.md)，补充当前生产公开宿主的真实浏览器消费验收。这里是独立验收页面及模拟提供者，不是产品 UI、平台插件或真机发现实现。

本次交接只完成夹具、验收驱动和静态检查，**未执行 Node、服务或浏览器，不能计入通过证据**。主代理须在当前二进制和 production host 均构建完成、相关输入冻结后串行运行；debug/release 各有独立报告，不引用上一阶段的浏览器或 npx 报告代替本批。

## 文件职责与依赖

| 文件 | 职责 |
| --- | --- |
| `../unified-discovery-browser-smoke.mjs` | 选择已有 debug/release Rust 二进制，创建独立数据根，记录输入和包摘要，启动本次宿主、协调浏览器与正常退出，保留失败证据 |
| `fixtures.mjs` | 打包本轮独立 API3 服务器包及 SDK2 浏览器包，复用已冻结 `npmTgz`；另由 RAW-NODE `fixture` 生成协议3/API3 包 |
| `provider.mjs` | 实际协议2子进程提供完整模拟观测、配置和回显，记录自身请求/响应/退出链；不连接设备、不读取工具路径 |
| `browser-plugin.mjs` | 经在线包上传的真实 ESM，使用公开 devices、订阅、面板及命令；相对模块 UUID 区分重载代次 |
| `harness.mjs` | 浏览器消费 `/assets/plugin-host.js`，通过 runtime 在线上传、装卸、设备查询/动作与原字节代理完成逐项断言 |
| `bridge.mjs` | 独立 loopback 静态生产资源与真实 HTTP 转发；可暂缓一次已完成真实 refresh 的响应送达，不制造业务响应 |
| `browser-driver.mjs` | 独立隐藏 Edge/Chrome 配置目录，CDP 执行验收，记录实际版本及 OS exit/close；不改现有公共驱动 |
| `lifecycle.mjs` | 摘要、有界等待与本次子进程退出收敛；强制停止只作用于本轮持有的子进程句柄 |
| `raw-node-control.mjs` | 只读依赖已交接的 RAW-NODE 导出，适配 fixture/control/release/events/started/cleaned，保存协议3清理、EOF和退出证据 |

RAW-NODE 已由主代理确认接口冻结且 Kuhn 接线后才接入，入口见 [其 README](../unified-discovery/README.md)。本轮只读该目录及其已冻结 device-provider 辅助，没有修改 Galileo 文件；A/B 响应路径仍使用本轮独立提供者，不依赖 RAW-NODE 内部实现。不修改既有 browser-plugin-smoke、frontend 或公共根文档。若之后需要旧绑定入口或内部接受门闩，应明确交接夹具/配置接入点再扩大覆盖。

## 主代理执行入口

项目根目录、Node 22 或更新版本、已安装 Edge/Chrome，已有 `backend/target/{debug,release}/apk-server`（Windows 为 `.exe`）及 `frontend/dist/assets/plugin-host.js`：

```powershell
node scripts/unified-discovery-browser-smoke.mjs
node scripts/unified-discovery-browser-smoke.mjs --release
```

可以使用 `DEVICEFORGE_TEST_BROWSER` 指定浏览器可执行文件。本脚本不调用构建器、不使用 Vite、不安装依赖；浏览器加载 production host 及其生产相对资源。服务器进程过滤继承环境中的 `APK_*` / `DEVICEFORGE_*` 后设置本次数据根、随机 loopback 端口和 Node 路径，按当前默认免鉴权模式运行。令牌不写 URL、报告或浏览器存储。

每次报告位于新建的 `artifacts/unified-discovery-browser-{debug,release}-*/report.json`；同目录保留本次 `server.tgz`、`browser.tgz`、`raw-node.tgz`、删除部署前采集的 `provider-events.jsonl` 与 RAW-NODE `raw-node-events.jsonl`，不覆盖历史报告。前两包由本轮源码在线打包，后一包由已冻结 RAW-NODE `fixture(id, 本次管理员根, {protocol:3,devicesApiVersion:3,executionTimeoutMs:120000})` 构造；管理员路径只进入夹具配置，不进入发现业务输入或公开 SDK。

实际启动命令、Node/浏览器版本、Rust 与 production host 摘要、夹具归档摘要、相关源码/产物输入前后摘要、API 日志 ID 和逐步失败位置写入报告。Browser runtime metadata 使用 CDP `Browser.getVersion` 的 product/revision/protocol，另记录可执行文件摘要、PID、实际 OS exit/close 及是否强制停止，不以预设版本代替采集。

## 适用验收项

| 项目 | 必须观察的真实证据 |
| --- | --- |
| API3 原文与预算映射 | HTTP `raw_state` 与公开 SDK `rawState` 保留前后空格、大小写和中文；特殊状态仍为规范 `unknown`；省略预算与 None 字段不合成属性 |
| 完整观测替换 | 配置 None 后新 Job 的整份 HTTP/SDK/插件订阅均无旧原文；恢复 raw 产生新发现，不从历史补值 |
| 规范状态准入 | recovery/sideload/bootloader/未知/offline/unauthorized 被 SDK 按规范状态拒绝，真实 online 动作 Job 成功；本地拒绝没有伪造日志 ID |
| 直接 discover | 公开 submit 产生真实成功 Job，GET 当前目录关联该 Job；不提交包装发现或额外发现来补关联 |
| refresh 自己的回执 | 取得真实 A 成功响应后暂缓送达，真实 B 更新 GET；释放后原 A 响应仍含 A 的 Job ID，没有改写成 B |
| 晚到 A 不覆盖 B | SDK 等待 A，真实 B 发布并经 GET 被本地观察；释放 A 得到现有 stale 错误且保留 A 的真实日志 ID，snapshot 仍为 B |
| 浏览器热卸载 | A 已被服务端接受后，插件命令仍等待送达；停用结束本地等待、订阅和 DOM，GET 可保留已接受目录；新运行相对 ESM 图 UUID 改变，旧上下文不复活 |
| 服务器热卸载/换代 | 本实例管理清本地目录与选择，GET 无旧代；新代未发现不能恢复缓存，旧 A 不影响新观测；SDK 与 HTTP 分别拒绝旧引用，历史已成功 Job 保留 |
| RAW-NODE 协议3来源 | 七次独立标签的 raw/missing/null 观测逐份替换；规范 online 的厂商原文仍可执行 device_read；每次通过 frozen cleaned 验证清理、响应、真实 EOF、零退出和 PID 不存在 |
| RAW-NODE 完成前取消 | 等待真实 started 的 hold 场景后取消本地等待，代理断开尚未完成的上游请求；实际 cancel_received、cleaned、EOF和退出均成立，GET 无候选；不推断 Succeeded 后决定竞争 |
| RAW-NODE 运行中提供者卸载 | started 后本实例停用真实 hold 提供者，等待由本地取消或真实409 conflict结束；后者必须以相同日志ID关联代理实际响应。取消帧/清理/EOF/退出链收敛，目录与入口撤销；新代未发现保持无观测，新发现恢复可消费目录 |
| 在线部署删除与退出 | 两类部署通过 runtime 用例删除；删除前采集夹具退出链；浏览器与 Rust 均正常 OS exit/close 且未强制停止；输入摘要前后一致 |

`passed=true` 要求逐项行为、退出收敛、无代理错误及输入稳定全部成立。浏览器异常、代理错误、超时、非零退出、强制停止或摘要变化都会使本轮失败。失败保留本次临时目录与有界诊断，成功才清理经边界验证的本次临时根；不恢复或清理用户工作区，不杀无关进程。

## 决定点与未执行边界

响应门闩只匹配一次实际 `POST /api/v2/device-providers/raw_browser_provider/refresh`。代理取得后端完整成功响应、验证真实日志 ID 和目录身份后，保留原状态/响应头/字节，再开放下一次请求。控制端点只存在于本次 loopback 验收代理，没有给生产 API 添加回执或权限字段。门闩不替换返回正文，不让 mock transport 代替真实服务器。

RAW-NODE hold 使用不同提供者 ID，通过其 frozen control/started/cleaned 与真实进程事件验证。上游还未形成响应时，浏览器断开会取消本次转发；上游已经完整接受并被响应门闩保留时，释放原字节只控制送达，不撤回接受。管理员 control 不放入 `{}` 发现输入，release 接入只作用于本次标签；取消场景使用 complete，不通过 release 假造协议3取消。

这可以证明“已接受 A 的响应不会冒认 B”与前端修订保护，**不能证明内部 attemptgate 的决定顺序、存储等待者暂停或 A 尚未接受时 B 的串行行为**。浏览器卸载用例选择接受先赢的可公开观察路径，之后取消本地等待不回滚服务端目录；没有把浏览器 abort 墙钟顺序当作取消先赢证据。规范状态拒绝和旧引用分别记录本地错误与实际 HTTP 错误，只有后者关联服务器日志 ID。

独立协议2服务器热卸载测试发生于响应送达等待阶段，夹具执行已经结束；另由 RAW-NODE started/cleaned 在协议3模拟工作运行中验证本实例提供者卸载。二者均不证明硬件进程清理、常驻会话或未知副作用已停止。夹具记录自身协议进程 exit，RAW-NODE 额外核对 EOF 和 PID 不存在；Rust/浏览器通过本轮持有的 child process 记录 OS exit 和 stdio close，这些是不同证据。浏览器删除只停本实例，不能强制停止同事的其它浏览器；已执行 ESM 内存不能卸出，新代运行路径只保证模块图重新执行。

本批不覆盖 MCP、绑定格式2及 android/harmony 旧数组入口、API1/2 兼容来源、真实 ADB/HDC 原文、重启恢复、Job Succeeded 后取消/接受拒绝、两发现额度或总期限的内部竞争。上述由主代理独立集成验收；本脚本通过也不能关闭完整 RAW-02 矩阵。目录远端变化仍依赖显式刷新，没有推送、后台轮询、常驻发现或产品界面承诺。

当前交接不产生浏览器报告，也不补造摘要、版本、退出码或通过数。主代理运行后需审核逐项结果、输入稳定性及退出证据，再把适用项纳入当次 RAW-02 门禁。
