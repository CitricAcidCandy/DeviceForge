# 普通操作总期限生产浏览器验收

本目录是 LONG-BROWSER 独立验收输入，依据后端 [普通操作总期限第一批契约](../../backend/docs/普通操作总期限第一批契约.md) 和前端 [消费契约](../../frontend/docs/普通操作总期限消费契约.md)。只消费真实 production host、在线浏览器插件及普通任务；不新增产品页面、UI、执行路由或浏览器预算覆盖。

本次交接未运行语法检查、构包、Node 项目脚本、Rust 服务或浏览器，不能记录为通过。Galileo 三文件实现已冻结，消费方仅只读核对其接口与响应层级；夹具与本脚本的运行门禁仍由主代理统一执行。

## 文件职责与只读依赖

| 文件 | 职责 |
| --- | --- |
| ../ordinary-deadline-browser-smoke.mjs | 选择已有 debug/release 二进制，独立启动宿主，协调浏览器、有界退出、失败保留和实际输入摘要 |
| fixtures.mjs | 使用既有 npmTgz 构造本轮浏览器包，只映射 helper 的公开操作 ID |
| browser-plugin.mjs | 真正上传运行的 SDK2 ESM：读取 execution、订阅目录、submit/getJob 有限 default；panels 为空 |
| harness.mjs | 原生导入 /assets/plugin-host.js，经 runtime.pluginPackages 上传/启停/删除；逐项断言及历史/旧引用检查 |
| package-client.mjs | 动态读取 Galileo createFixtures，核对归档、default 身份/事件/真实 PID 退出，保存失败控制证据 |
| bridge.mjs | 本次 loopback 静态资源、配置、控制和真实 HTTP 原字节转发；不合成业务 DTO |
| report.mjs | 输入树/摘要、真实宿主请求日志及就绪检查 |

只读复用 scripts/unified-discovery-browser/browser-driver.mjs、lifecycle.mjs 和 backend/scripts/online-plugins/fixtures.mjs。Galileo 打包辅助及其静态依赖 scripts/device-provider/fixtures.mjs、client.mjs 也纳入实际输入摘要。公共浏览器驱动提供实际 Edge/Chrome 版本、可执行文件摘要、PID、OS exit/close、未捕获异常与强制停止信息；本目录不修改公共驱动、RAW matrix、frontend 或 Kuhn HTTP/长进程脚本。

## 主代理最小执行要求

须使用已冻结的 scripts/ordinary-deadline/fixtures.mjs、plugin-process.mjs，并已有最新生成 DTO、LONG-FE 门禁产物、backend/target/{debug,release}/apk-server（Windows 带 .exe）和 frontend/dist/assets/plugin-host.js；Node 22 或更新版本，安装 Edge/Chrome。主代理先做语法门禁，输入冻结后在项目根串行执行：

~~~powershell
node scripts/ordinary-deadline-browser-smoke.mjs
node scripts/ordinary-deadline-browser-smoke.mjs --release
~~~

DEVICEFORGE_TEST_BROWSER 可指定实际浏览器。入口不调用 Cargo/npm/生成器/Vite/构建，不安装依赖，默认免鉴权；过滤继承 APK_*/DEVICEFORGE_* 后只设置本次端口/数据/部署/Node路径及请求限额。浏览器不获得 controlRoot、本机路径或令牌，报告不保存鉴权头或正文中的敏感配置。

Galileo 冻结接口为 createFixtures(directory,report)，不改共享 report，返回共享 runId、不同 pluginId 的两个 protocolVersion=2/3 条目，每项含 archivePath、archiveSha256、controlRoot、operations:{long,short,default}、shortTimeoutMs:10000。operations 返回完整公开 ID；包长预算120000、短预算10000，default未声明；helper目录及README仅只读。缺导出或产物时报告明确前置缺失，不手写替代服务器包。

## 适用验收项

| 验收项 | 必须保留的真实证据 |
| --- | --- |
| 在线安装及声明消费 | 两种服务器TGZ与浏览器TGZ经过runtime.pluginPackages.upload，服务器启用、浏览器ESM真实执行；实际归档摘要 |
| snake/camel字段 | HTTP execution严格含api_version/total_timeout_ms/source；上传插件通过公开context.listOperations取得apiVersion/totalTimeoutMs/source |
| 有效值及来源 | default=60000/default，long=120000/declared，short=10000/declared；公开订阅与查询一致，不按名称或浏览器默认值补元数据 |
| 有限调用 | 上传插件经公开context.submit仅发送{case_id}到default，再getJob有限查询终态；代理核对顶层只有operation/input，input只有case_id |
| 进程关联 | 实际Job/响应日志、成功result身份、ready/events与run/case/plugin/protocol/request/PID一一核对；单进程单调时钟不跨进程相减 |
| 真实退出 | default的response_written/cleaned/stdin_eof/process_exit事件，零退出事件和PID实际不存在分别核对；Rust及浏览器OS exit/close均正常且没有force |
| 服务器卸载与历史 | 本实例停用后当前目录/订阅撤销；旧Job保持可读、不补当前execution或totalTimeoutMs，结果与input不随重载/删除改写 |
| 浏览器卸载 | 登记资源和订阅释放，原HostContext拒绝调用、命令撤销；新UUID路径相对模块状态重新执行，旧上下文不复活 |
| 部署删除 | 两类在线包由runtime用例删除，本实例浏览器先停止；删除后历史仍可查，目录为空 |

浏览器内8秒有限终态等待属于验收超时，不更改服务端预算；整个harness有75秒上界。long/short只读目录，不提交hold、不写release。浏览器包没有面板、组件或产品页，独立验收页面body为空。

## 控制、结果与报告

default输入只能是ASCII ^[A-Za-z0-9_-]{1,80}$ 的本次case_id。case ID每次唯一，不复用旧marker。控制端点只读helper生成的本次控制根：<case_id>.ready.json及<case_id>.events.jsonl；本脚本不创建<case_id>.release。ready、事件和业务result的request_operation必须为SDK短名default，不用完整公开ID替代。

成功业务result严格消费固定身份和时序字段：
run_id/case_id/plugin_id/protocol_version/pid/request_id/request_operation/ready_monotonic_ns/completed_monotonic_ns/elapsed_ms。
它位于公开Job.result的result/artifacts包装内，不能把HTTP data、Job.result和业务result混作同一层，也不发送私有SDK响应包装。协议3合作取消不在本浏览器短调用中触发；不以协议2 stdin EOF冒充合作取消。

报告每次新增于 artifacts/ordinary-deadline-browser-{debug,release}-*/report.json，不覆盖旧报告；同目录保存本次两份服务器包、浏览器包、ready/events身份文件，以及实际已产生的diagnostic.json和残留resource文件。诊断只作为夹具自报证据，缺失不补造，尤其不能把协议2强杀后的缺exit或cleaned写成正常退出。记录当前Rust与production host字节摘要、Node/浏览器runtime、实际输入前后摘要、API日志ID、逐步结果、OS退出和有限清理错误。失败保留本次临时根及已有控制事件；成功才删除经过绝对路径边界核对的本次临时根，归档报告始终保留。强制停止只使用本次spawn得到的句柄，并使本轮失败，不杀无关进程。

passed=true须同时满足六组浏览器步骤、两项default进程证据、真实Rust/浏览器正常退出、代理无错误以及实际执行输入前后稳定。摘要只覆盖实际使用的新脚本、只读helper/驱动/打包辅助、契约和生产资源/二进制，不因不执行Rust源码而冻结全部Rust工作区。

## 不可扩大为通过的范围

短default即时成功可以证明在线SDK消费与有限任务对接，不能证明声明120000真的执行超过旧60秒、10000到期取消、协议2/3清理竞争或普通截止点贯穿全程。跨61秒真实长执行由Kuhn另验；report.boundary始终保留over61SecondsVerified=false/longSubmitted=false/shortHoldSubmitted=false，不因本轮passed改为true。

marker和cleaned仅属于本次受控夹具证据，不能单独证明外部资源已释放；PID不存在是独立核对，也不扩大为进程树或真机事务清理。客户端等待取消不等于Job取消。浏览器删除只停止本实例，不能强制停止同事浏览器；新路径不卸出旧ESM内存缓存。

旧目录缺省/null、非法版本/source、protocol错误日志及历史不补元数据的细粒度兼容由LONG-FE单元回归另验，本脚本不让真实后端伪造坏目录。没有远端推送、产品UI、真机、性能会话、npx或本批完整分发保证；已有RAW和旧release报告不能充当本批运行证据。

当前仅源码可评审，已按冻结helper接线；主代理应先执行语法门禁，最后独立运行debug/release并审核报告。未执行的检查与浏览器通过数保持未验证，不由静态交接补造。
