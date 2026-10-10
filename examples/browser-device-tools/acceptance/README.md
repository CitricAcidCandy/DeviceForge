# 第三方浏览器示例真实验收驱动

本目录只验收 [已冻结示例](../README.md)，不增加产品页面，不替代前端界面设计。入口 `run.mjs` 由主代理统一运行；开发角色没有运行 Node/npm/Cargo、打包、构建、服务或浏览器。本目录新增文件不修改示例原十文件，也不在其标准包白名单内。

## 冻结输入与前置条件

本轮示例十文件汇总为 `48C708080D56EB7DE6C2C8CEF55A52DC3FF4E8AB534A7C989ABD073E6CC35BC5`，逐文件值保存在 `frozen-inputs.json`。该版本包括 EX-01 非安全上下文激活标记修复、EX-04 同步接受设备结果修复以及新增的两项确定性回归。原 README 中七项回归记录是先前交付历史，当前主代理已经执行九项；真实浏览器仍须本驱动另验，不将模拟测试当浏览器结果。

默认消费主代理正式原包：

```text
artifacts/browser-example-20261010-004118/deviceforge-browser-device-tools-example-0.1.0.tgz
SHA256 79DE721D199B1BA71923EF8FEA6AAF93F162A5C5F0145905B186DD604ABF7726
```

主代理报告 `artifacts/browser-example-gates-20261010-004118.txt` 对应七个 MJS 语法、九项确定性测试和标准打包通过，inputs0。旧汇总 `241974...54C5A2` 与旧 TGZ `77A27D...4CE0EA` 不关闭新问题；驱动明确拒绝该旧包摘要。不会自行调用 npm pack。在线 ESM 五个源模块的真实响应摘要还须与冻结源逐项一致，避免仅凭归档文件名或手填摘要宣称加载了新版。

主代理运行前准备当前 debug/release `backend/target/<profile>/apk-server` 和 `frontend/dist/assets/plugin-host.js`。构建仍由主代理串行执行，驱动不调用构建命令。需要 Node 的内置 WebSocket、可用 Edge/Chrome 及实际非内部 IPv4 网卡；可用 `DEVICEFORGE_TEST_BROWSER` 选择浏览器。

编写时只读发现生产 `frontend/src/plugins/package-loader.ts` 还在使用 `crypto.randomUUID()`，已即时回流主代理。此为真实 LAN 激活前置阻断；主代理修复宿主并重建生产 ESM 后才能期待通过。驱动不改宿主、不注入 crypto polyfill、不改浏览器安全标志，也不以 loopback 通过替代 LAN 结果。

## 主代理最小运行路径

先对本目录七个 `.mjs` 做语法门禁，再从工程根目录运行：

```powershell
node examples/browser-device-tools/acceptance/run.mjs
node examples/browser-device-tools/acceptance/run.mjs --release
```

默认使用上述原包及摘要，LAN 地址沿用 CLI `networkConfig` 的实际网卡方法，排除整个 `127/8`，无可用地址直接失败。多网卡时主代理可选定本机实际 LAN IPv4：

```powershell
node examples/browser-device-tools/acceptance/run.mjs --lan-host 192.168.1.20
```

示例地址必须替换为当前机器的真实网卡地址，不能直接照抄；参数值必须属于 CLI 方法实际枚举到的非内部 IPv4。不支持用虚构 hostname、`localhost` 或 `127.0.0.1` 绕过。仅在主代理重新打包了同一冻结源码时，才可成对传 `--archive <路径> --archive-sha256 <摘要>`；驱动仍检查冻结源码和实际 ESM 响应，不能据此验收未经分配的新源码版本。

真实浏览器页面 URL 为 `http://<本机LAN IPv4>:<本次端口>/__verification`。必须同时满足 `window.isSecureContext === false` 与 `typeof crypto?.randomUUID !== 'function'`，否则 EXB-01 失败。CDP 控制端口仍在 loopback，这与页面 origin 不同，不可据 CDP 地址误判页面已使用 LAN。

桥只接受所选主机自身源地址的连接，页面与控制端点不用于同事客户端。此批证明本机经真实 LAN URL 的非安全上下文，不证明另一台局域网机器、防火墙部署或 CLI/npx 安装流程。

## 文件职责与固定接口

| 文件 | 职责 |
| --- | --- |
| `run.mjs` | 参数、冻结输入、实际 LAN 地址、独占真实后端、CDP、正常退出和失败证据编排 |
| `frozen-inputs.json` | 原十文件逐项与汇总摘要、被替代旧版摘要；不是 HTTP DTO |
| `fixtures.mjs` | 读取正式原包、调用冻结提供者 helper、构造有限在线消费者包、保留真实进程事件 |
| `consumer.mjs` | 在线第三方插件，通过公开 SDK 调用示例服务并订阅事件，无页面/私有导入 |
| `bridge.mjs` | 提供生产静态文件和真实 API 原字节代理、有限管理员控制及真实历史响应门闩 |
| `probe-context.mjs` | 公开生命周期/释放调用观测；可选 devices 缺省适配覆盖激活和贡献回调上下文 |
| `browser-checks.mjs` | 有界等待、错误摘要和逐项证据，不伪造 HostError |
| `harness.mjs` | 从生产公开 ESM 装配，执行九项真实浏览器场景 |
| `README.md` | 运行要求、验收项与未执行边界 |

只读复用 [CDP 驱动](../../../scripts/unified-discovery-browser/browser-driver.mjs) 的 `runBrowser({pageUrl,expression,profileDirectory,evidence,observeResult})`，以及同目录 `lifecycle.mjs` 的摘要、子进程观察和正常退出判定。实际浏览器版本、二进制摘要、OS exit/close 与未捕获异常沿其真实采集结果记录，不复制浏览器控制实现。

提供者只读使用 [统一发现夹具](../../../scripts/unified-discovery/README.md) 的 `fixture/control/started/cleaned/events/exited`，固定 API3、协议3、`example_synthetic`，插件 ID 按本次 runId 独立。设备业务输入仍按公开标准，不把控制标签、本机路径或预算塞入发现/动作输入。管理员场景标签只在本次独占控制目录中使用。归档构造只复用冻结的 `npmTgz`，不复制通用 TAR。

桥接口只属于验收页，不授予第三方插件：`GET /__configuration`、`GET /__fixture/{example|provider|consumer}.tgz`，以及有限 `/__control/provider/{set|started|cleaned}`、`/__control/gate/{arm|state|release}`、`/__control/stats`。gate 仅允许按实际 Job ID 暂扣下一次真实 GET Job 成功响应，保留原状态、日志头与字节；不修改业务值、不制造假服务器错误。

## 九项真实浏览器验收

| 编号 | 场景与接受条件 |
| --- | --- |
| EXB-01 | 实际 LAN HTTP 为非安全上下文且缺少 randomUUID；正式 TGZ 在线上传并启用；8 命令/2 服务真实登记 |
| EXB-02 | 公开目录发现、完整引用选择、精确只读能力调用；原协议3包装读取；版本不匹配和 write 能力在调用前拒绝 |
| EXB-03 | 通过示例 submit 的普通操作真实成功；另一在线插件经 SDK 调用目录/历史服务；真实 hold 动作经 cancel-job 收敛并核对取消、EOF和PID退出 |
| EXB-04 | 显式省略真实公开 devices 的兼容适配：目录返回 null、设备命令明确失败，普通 submit/历史仍调用真实服务，退出没有设备订阅残留 |
| EXB-05 | 真实发现进程 hold 后停用服务器提供者，浏览器等待及时 cancelled；目录/选择撤销、合作清理和实际PID退出；重载换代，旧引用拒绝、新代恢复，历史不变 |
| EXB-06 | 当前示例钩子拒绝目录中缺失操作；实际桥记录证实零 POST Jobs |
| EXB-07 | 另一在线插件发起历史服务调用，门闩已取真实成功响应；卸载示例后等待在放行前 cancelled；贡献/订阅释放、旧上下文拒绝、晚响应不复活服务 |
| EXB-08 | 钩子撤销后同一未知操作到达真实服务器并取得错误日志ID；重载新运行路径/新插件代次/新本地标记，旧上下文仍拒绝，新服务及状态恢复 |
| EXB-09 | 删除本浏览器示例与消费者，再删除本次提供者；当前部署/贡献收敛，旧历史仍读取且不补当前元数据；所有示例代次的公开释放观测收敛 |

EXB-04 不伪称生产 runtime 提供了关闭 devices 的配置。生产默认仍有 devices；该项只验证 SDK 可选字段缺省兼容。适配器只转发真实方法、信号、登记和响应，既不模拟 HTTP/Job，也不新增公开类型。示例与消费者内部没有测试桥、runtime、令牌或服务器工具路径。

本轮不能在真实浏览器制造原 EX-04 两个微任务续执行间的精确内部窗口；该窗口由新版九项确定性测试中的新增回归证明。EXB-05/07 仅增加真实端到端撤销证据，不冒充内部调度证明。普通目录、设备预算或 Job 结果都不由驱动覆盖，不把短调用冒充跨61秒长进程执行。

## 报告、退出与失败留证

每次输出到独立 `artifacts/browser-device-tools-acceptance-<debug|release>-<runId>/`，包含 `report.json`、三份实际上传 TGZ 和提供者事件 JSONL。不会覆盖先前失败版本。报告记录十文件与驱动输入前后摘要、正式包 SHA、生产 host 与 Rust 二进制摘要、真实 LAN URL、浏览器版本/二进制/PID/退出、逐项结果和服务器日志 ID。SDK 日志还要能对应桥取得的真实响应头。

所有 API 都经真实 Rust 后端，桥不重写成功/失败包装。门闩截获的是实际历史成功响应；先观察卸载取消，再放行原字节，不把构造的 logId 当服务器日志。提供者 `cleaned` 标记必须同时具有匹配身份的响应/EOF/退出事件及独立 PID 不存在核对，不能只凭 marker 宣称清理。

浏览器与 Rust 都须正常 OS exit/close 才能通过。失败分支只对本驱动创建的浏览器/后端进程做有界退出与必要终止，记录强制状态；不按名称杀进程、不直接强杀任意提供者 PID。运行目录由 `mkdtemp` 生成，成功后验证绝对路径位于临时根再删除，仅限本次目录；失败保留目录、身份事件和有界诊断。退出或证据失败会令整体失败，不吞掉为通过。

初始编写交接仅做静态编码、路径和摘要核对，语法/执行结果由主代理实跑生成。没有本批浏览器通过证据，不引用其他版本 debug/release/npx 或九项模拟测试扩大结论。普通缺陷按 EXB 编号汇总回流；前置缺失、脚本语法、在线安装或 LAN loader 激活阻断即时回流。下一批源码修复需重新分配写权，不能修改已冻结示例或公共脚本。
