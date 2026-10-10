# 任务历史与事件生产浏览器验收

本目录是独立验收驱动，不是产品页面。消费已经构建的 `/assets/plugin-host.js`、公开 SDK API2 可选 `HostContext.taskHistory` 和现有 HTTP `/api/v2/jobs`、`/api/v2/jobs/{id}`、`/api/v2/jobs/{id}/events`，不导入宿主私有源码。实施依据为[任务历史与事件第一批裁定](../../frontend/docs/任务历史与事件公开接口第一批裁定.md)，插件开发用法见[接入示例](../../frontend/docs/任务历史与事件插件接入示例.md)。

当前开发角色已完成 Node 语法与实际浏览器插件契约校验，真实浏览器及服务由主代理执行。主代理须先完成实际前端门禁和生产构建，再串行执行下面命令；静态通过不代表浏览器验收通过。

## 最小运行要求

在工程根目录，由主代理执行：

```powershell
node scripts/browser-task-history-smoke.mjs
node scripts/browser-task-history-smoke.mjs --release
```

前置输入：Node 支持全局 fetch/WebSocket（现有驱动使用 Node 24）、Windows Edge 或 Chrome、`frontend/dist/assets/plugin-host.js` 及同一生产构建的依赖、分别存在的 `backend/target/debug/apk-server.exe` 与 `backend/target/release/apk-server.exe`。可用 `DEVICEFORGE_TEST_BROWSER` 指定浏览器可执行文件，仍记录实际 CDP 版本和二进制摘要。驱动不会执行 Cargo/npm/生成器或修改 dist，不使用运行中的用户宿主。

每次运行在独立临时根创建数据与部署目录，选择回环端口，启动一个本次 Rust 宿主和一个独立 profile 浏览器。默认免鉴权；不读取或保存服务令牌。代理从现有 dist 供给生产模块，API 请求透明转发到本次 Rust 服务。有限协议2回显包通过冻结的 `backend/scripts/online-plugins/fixtures.mjs::serverFixture(2)` 构造；浏览器包包含本目录实际 `browser-plugin.mjs`，两类 TGZ 都通过现有 `npmTgz` 生成并保存到本次 artifacts，不调用 npm、不执行安装脚本。

浏览器 harness 必须通过公开 `RuntimeOptions.esmImporter` 注入原生模块导入，导入前后复核生命周期 signal。面板贡献使用完整 `task_history_browser_probe.left/right`，其挂载、卸载及 `panelTarget` 均使用同一 `config.panelIds`；探针内部 `panels.left/right` 只是验收记录键，不作为宿主贡献 ID。

## 静态契约复核与原失败

主代理的前两次真实 debug 失败分别保留于 `artifacts/browser-task-history-debug-uHrfow/report.json`（TH-B01 缺少 ESM 导入器）与 `artifacts/browser-task-history-debug-ig5PYT/report.json`（TH-B01 面板 ID 未加插件命名空间）。两项均为独立验收夹具装配缺口，生产默认和校验规则保持不变。

修正后已逐项核对实际 SDK、`readPluginModule/validateContributions`、管理器及任务历史适配器：

| 边界 | 静态核对结果 |
| --- | --- |
| 归档描述与入口 | package.json、plugin.json、实际模块 id/version/API2 一致；browser 入口 `dist/index.js`；服务器协议2短名 `echo`，公开操作 `plugin.online_echo_v2.echo` |
| ESM 装配 | harness 显式注入 importer，默认公开 resolver 保留本代资源前缀；不导入宿主私有源码 |
| 面板 schema | 两个面板均为插件命名空间内唯一 id、非空 title、异步 mount 返回释放函数；实际生产契约校验器直接接受修正后的模块 |
| 挂载与退出 | mount/unmount 使用完整面板 ID；目标映射只接受本插件两个精确 ID，探针记录键独立；退出左侧不会移除右侧目标 |
| 任务与历史 | submit/getJob 及历史 list/get/events 参数顺序与公开 SDK 一致；旧 Job 仍为五字段，事件 cursor 用 after；产物包装仍留在 result 内 |
| 撤销与清理 | pluginPackages.disable/remove 与 runtime.dispose 沿现有公开入口；七个回执门闩不调用 cancelJob；晚拒绝被传输观察器消费 |

全部九个本目录 `.mjs` 经 `node --check` 退出 0。另以 Node 直接调用源码契约校验器验证实际浏览器模块，并核对同次 `createFixtures()` 生成的描述、面板 ID 和操作 ID，退出 0；这项检查不执行服务器、浏览器或模拟 HTTP，不代替真实十项验收。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `../browser-task-history-smoke.mjs` | 输入摘要、夹具归档、独立进程启动、报告与有界清理 |
| `fixtures.mjs` | 复用有限服务器包，构造真实在线浏览器包 |
| `browser-plugin.mjs` | 通过 activate 与两个实际 panel mount 保存公开实例/子上下文及释放探针 |
| `bridge.mjs` | 生产静态资源、真实 API 回执转发、状态/日志/回执字节摘要 |
| `gates.mjs` | 扣留已取得的真实回执，提供仅验收用控制与有界释放 |
| `browser-evidence.mjs` | 浏览器断言、实际传输记录、取消门闩和日志关联 |
| `history-scenarios.mjs` | 在线安装、有限任务、list/get/events、错误与游标断言 |
| `cancellation-scenarios.mjs` | caller/挂载/插件/runtime 撤销、旧引用/兄弟/新代与历史独立 |
| `harness.mjs` | 从生产入口装配公开 runtime，串行场景、捕获拒绝与 DOM 退出 |

只读复用 `scripts/unified-discovery-browser/browser-driver.mjs` 和 `lifecycle.mjs` 的 CDP、OS 退出与摘要，以及 `scripts/ordinary-deadline-browser/report.mjs` 的清单/宿主就绪工具；不复制通用 TAR/CDP。实际用到的本地模块、契约、生产 dist、Rust/Node 输入均纳入运行前后清单，浏览器二进制另作前后摘要核对。

## 十项验收与真实证据

| 编号 | 触发与预期 |
| --- | --- |
| TH-B01 | 通过 runtime.pluginPackages 上传/启用两类包，公开上下文提交两项有限回显，核对真实 Job 结果与旧 Job 字段 |
| TH-B02 | list 缺省/limit=1/200 与 HTTP 比对，get 精确 id，snake_case→camelCase 映射、真实 logId、历史不补当前元数据 |
| TH-B03 | events 缺省/0/已消费序号/末序号，安全整数、严格升序、精确 jobId、只返回 after 后事件；允许序号间隙 |
| TH-B04 | 不存在任务的真实 404/not_found 与本次 HTTP 日志关联；无效 limit/after/id 本地 protocol 拒绝且零传输 |
| TH-B05 | 三入口 caller 预取消零传输；扣留真实响应时 caller 取消及时拒绝，释放后原拒绝不改变，任务历史仍存在 |
| TH-B06 | 真实 HTTP 回执抵达后，验收传输注入晚拒绝，已经取消的调用不改变且无 unhandledrejection |
| TH-B07 | unmount 左挂载取消在途查询，三个旧入口零传输，DOM/释放探针收敛；右挂载继续查询 |
| TH-B08 | 在线停用撤销实例与右挂载；原实例/两挂载零传输；重新启用得到不同 ESM 入口与新上下文，旧引用不复活 |
| TH-B09 | 通过 runtime.pluginPackages 删除两端部署，撤销当前浏览器实例和操作目录；公开根历史仍原样，事件与 TH-B03 完整数组逐字段一致，不补预算/代际 |
| TH-B10 | runtime.dispose 撤销根历史在途等待和三个旧入口，不删除或取消服务器 Job |

门闩在真实后端响应已完整取得、状态和包装日志已核对后才标记 ready。浏览器传输对这七次受控请求故意忽略 signal，撤销必须在门闩释放前及时拒绝；这不是模拟宿主或模拟历史。晚拒绝是验收传输故障，报告明确记录，不能称服务器发生了该错误。SDK 的 logId 必须匹配本次传输及代理记录的真实响应头；本地取消/参数错误维持 null，不补造服务日志。

TH-B01 为等待有限任务结束而作有界完成观察；不增加产品历史轮询、事件订阅或重连机制。所有查询取消都检查没有调用 `/cancel`，历史查询 Abort 不等于服务器任务取消。事件只按公开游标逐次读取，不假定序号连续或时间严格递增。真实输出仍保留协议2 `result + artifacts` 包装，不能把内部 result 当成整个 Job 结果。

## 报告、退出与失败保留

每次输出 `artifacts/browser-task-history-{debug|release}-<本次身份>/report.json` 与实际上传的 `server.tgz`、`browser.tgz`。报告记录生产宿主/Rust/Node/浏览器摘要、serve identity、实际 CDP 版本、归档字节与摘要、逐项证据、真实请求日志、门闩状态和输入清单前后差异。Node 生成运行身份；浏览器夹具使用 `import.meta.url` 的代次路径识别，不要求安全上下文 UUID，也不把路径标记称作 UUID。

浏览器 evaluate 返回后先保存功能结果，再独立核对 OS exit/close/forced。因此“十项功能绿但浏览器退出红”保持整体失败，不能把清理红覆盖成通过。整体 passed 还要求本次 Rust 宿主正常关闭后重新绑定其具体 `127.0.0.1` 端口成功、代理无错误、七个门闩完整交付且不超时、所有输入零变化。端口重绑仅观测本次端口，不终止占用它的其他进程。只会对直接 spawn 的本次子进程进行有界收敛，不杀其他 PID。失败保留本次临时根和有界进程诊断；成功仅在绝对路径范围核对后删除本次 mkdtemp 根，artifacts 报告与 TGZ 始终保留。

## 实现与证据边界

没有产品 UI、平台真机、长进程期限、服务器重启历史、npx 分发或本轮非安全 LAN 验收。回环浏览器通过不能替代既有独立 LAN 驱动；也不证明可信插件副作用已强制停止、外部插件资源完全清理或 ESM 已退出内存。同事其他浏览器实例不会由当前 remove 强制停止。HTTP/SDK 无新增字段，服务器与生产构建的实际验证由主代理执行；失败及修正版须分别保留。
