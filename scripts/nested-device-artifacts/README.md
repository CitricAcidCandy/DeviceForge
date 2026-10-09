# 嵌套设备输入产物真实集成验收

在项目根目录执行 `node scripts/nested-device-artifacts-smoke.mjs`；发布模式追加 `--release`。脚本只读取集成负责人已交接的 `backend/target/{debug|release}/apk-server`，Windows 使用 `.exe`，不编译、不调用 npm、不准备或修改 runtime。首次交付只完成语法检查，须等待当前宿主构建和授权后再实跑，不能用旧二进制验证新契约。

每轮报告写入 `artifacts/nested-device-artifacts-smoke-{profile}.json`，包括阶段、精确错误类别、共享历史任务、公开产物元数据、真实调用 PID 和响应/EOF/退出事件。`passed` 与真实命令退出码共同表达验收结果；文件存在或语法通过不能表示集成通过。

## 文件职责和依赖

- 根入口 `nested-device-artifacts-smoke.mjs`：串行调度阶段、保存原失败请求和报告。
- `suite.mjs`：供独立入口及 npx 分发验收复用的完整步骤；保留原有插件/提供者基线，不要求共享宿主已部署的插件为空。
- `host.mjs`：空临时部署、默认免令牌真实宿主、自有进程退出、日志关联和有界清理。
- `client.mjs`：复用既有公开 `createClient`；补充二进制下载、30 秒共享任务终态检查和公开元数据形状。
- `fixtures.mjs`：协议 2/3 自包含在线 TGZ、完整/宽松输入 schema、坏选择器及真实进程观测。
- `provider.mjs`：TGZ 内独立 Node 入口；发现、嵌套副本核对、JSON 输出、协议 3 取消与 EOF 收尾。
- `installation.mjs`：精确安装拒绝、无残留、声明保留、显式加载与发现。
- `artifacts.mjs`：真实上传、HTTP/MCP 共享能力任务、摘要/原字节、未声明 ID 和两种坏终值拒绝边界。
- `lifecycle.mjs`：取消、在途卸载、代际引用、历史及已发布产物保留。

归档复用 `scripts/device-provider/fixtures.mjs` 的 `archive(files)`，该旧文件仅新增导出，不修改 TAR 逻辑或旧验收行为；不复制第二套 TAR 构造器。JSON/MCP 客户端复用 `scripts/device-provider/client.mjs`，摘要与部署快照复用 `backend/scripts/online-plugins/fixtures.mjs` 的已有导出；这些旧模块均不改实现。

## npx 验收复用入口

`fixture(protocol, markerRoot)` 返回 `id`、`protocol`、管理员标记 `directory`、`manifest`、有效 `archive` 和坏清单归档列表 `invalid`，协议参数为 2 或 3。夹具目录必须属于调用方本次临时目录，结束前确认进程退出；归档构造无需 npm，也不启动任何进程。

`verifyNestedDeviceArtifacts({host,fixtures,report})` 执行在线安装这一整套步骤，不自行启动/关闭宿主。调用方传入其真实宿主适配对象：`client` 与 `download` 可由 `clientFor(base, report)` 创建；`plugins` 指向该宿主自有插件目录；`logs` 可使用 `() => readHostLogs(dataDirectory)`；`assertRunning` 核对调用方直接持有的 ChildProcess。`report` 需要 `checks:[]`，函数返回历史任务 ID 与原有包/提供者基线。函数删除的部署仅为本轮两个夹具，既有插件和提供者须与基线一致；服务和临时目录清理由调用方负责。

实际 npx 分发必须先用 CLI `plugin install` 安装两个 `fixture(...).archive`，随后自行 load 并复用 `discover`、`verifyArtifacts`、`writeArtifact` 和 `processEvidence`，不能用本总入口的在线上传作为 CLI 安装证据。独立 MCP 监听端口使用 `clientFor(base, report, {mcp: 'http://127.0.0.1:端口/mcp'})`；覆盖 tool/tools 及 action/manage 的 MCP 分支，HTTP 仍使用原 base，并合并两端日志 ID。原设备客户端不修改。

也可单独复用 `installProviders(context)`、`verifyArtifacts(context)`、`verifyBadValues(context)`、`verifyLifecycle(context)`，或 `writeArtifact(context,item,transport,label)`；完整流程优先复用总入口，避免复制步骤。`sourceBytes`、`decoyBytes`、`businessInput`、`discover`、`terminal`、`publicMetadata`、`processEvidence`、`events` 和 `exited` 均有导出。步骤 context 由总入口创建并维护 `history`、`baseline`、输入元数据和提供者引用；若单独组合，需要沿相同顺序传递该 context。

## 场景和固定断言

在两个空插件目录启动默认免鉴权真实 Rust，明确传 `DEVICEFORGE_NODE=process.execPath`，然后在线上传协议 2/3 两个 `synthetic_demo` 提供者。清单声明 `artifacts.input_pointers=['/input/artifact_id']`、`outputs=true`，能力封套仍为 `{device_id,input}`，业务输入仅传产物 ID，不选择服务器路径。

发现输入为 `{}`，上下文输入产物为空，夹具不读取产物文件，不输出文件。安装与加载均不得执行入口；发现保持共享任务和 HTTP/MCP 目录证据。此处不将 Node 自身模块加载或管理员标记写入误称为产物读取。

写能力核对输入上下文唯一副本的原 ID、`field='/input/artifact_id'`、大小和 SHA-256，读取合法 JSON 并原字节写入宿主输出目录。随后刻意修改输入副本；客户端下载输出、原输入及未声明对照文件，核对原字节与摘要，证明持久化原输入没有被修改。成功任务只含预期业务元数据和公开产物元数据，禁止暴露副本/输出目录路径。

业务输入另携带已上传但未声明的 ID，以及格式合法但不存在的 UUID。执行必须成功且上下文只有一个明确选择的输入；未声明 ID 不得被复制、查询或暴露。正常写能力分别走 HTTP/MCP，查询终态与事件也走两种公共接口。

坏 Pointer 清单仅使用空根、缺少前导斜线、非法 `~2` 转义、同类重复、顶层字段与等价 Pointer 重复、合计超过 8 项。安装固定要求 `400 invalid_input`，部署快照、包目录和设备贡献均无残留。`/input/..`、`/input/*` 是合法字面对象键，不是文件路径、父级或通配符，本脚本不把它们列为坏清单。

null、数字、对象和混合数组分别验证两层边界：完整 schema 的写能力在 HTTP 提交返回 `400 invalid_input`，MCP 业务错误固定为 `invalid_input`；宽松 schema 的独立能力提交共享任务后，准备阶段必须收敛为 `failed`，任务错误具有输入无效类别，关联日志固定为 `invalid_input`，且 Node 夹具未启动。报告明确区分提交拒绝和执行早期拒绝，不以任意 4xx、依赖失败或夹具断言失败替代。完整 schema 缺少产物 ID 也固定拒绝。

读取副本后的显式取消与在途卸载均验证共享任务 `cancelled` 和真实 PID 退出。协议 3 另要求实际取消帧、清理标记、响应写完、stdin EOF 和零退出，卸载返回时这些证据已成立。协议 2 只证明宿主停止本次直接进程，不声明外部资源合作清理。

卸载撤销提供者、设备目录和动态操作；重载得到新 generation，新目录不得隐式复活。旧动作及旧刷新引用分别通过 HTTP/MCP 固定返回 `409 conflict`，新代未观测动作也固定冲突。重新发现后再次成功生成产物，并核对成功/失败/取消历史和已发布产物在热装卸及部署删除后仍保留。

## 期限、清理和验证边界

不修改宿主既有设备 30 秒总期限；共享任务等待为 30 秒。正常 shutdown 后最多等 10 秒退出，超时立即使本轮失败；失败清理不能把超时改成通过。HTTP 二进制和一般请求仍使用 20 秒请求超时，夹具取消观察有界。入口不启动后台派生进程。

失败一律保留本次临时目录和首次失败请求，仅记录路径、方法、状态、日志 ID、错误类别及时间，不保存请求正文、凭据或任意插件输出。只关闭直接持有的宿主 ChildProcess；PID 观测只探测存在性，不按 PID 强杀。只有通过且全部夹具已退出时，检查本次绝对临时路径位于系统临时目录内，再删除本次目录。

本脚本证明本机可信插件的离散 HTTP/MCP 产物调用，不证明常驻传输、真机资源恢复、跨平台、系统隔离、浏览器 UI、性能容量或重新打包后的 npx 分发。输出持久化是宿主产物存储能力；模拟提供者不持久化设备资源。RFC 6901 转义、Unicode、数组索引、全选择器/数量上限及选择前无文件副作用的完整组合由后端纯规则与端口测试另行覆盖。
