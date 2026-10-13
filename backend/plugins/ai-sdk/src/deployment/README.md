# 固定包入口与部署配置

`deployment.rs` 从当前原生插件可执行文件所在目录解析固定包成员。默认配置为同目录 `ai-sdk.config.json`，worker 为同目录 `worker/dist/index.js`，加载探测为 `worker/dist/probe.js`；服务工作目录、浏览器参数及环境变量均不参与 worker 选择。私有 exec 代理、监督和 sentinel 复用当前插件可执行文件。

公开清单默认 `args: []`。管理员可在清单声明 `args: ["--config", "绝对配置路径"]`，只改变部署配置读取位置；相对配置、未知参数、缺参数或额外参数均拒绝。部署配置继续仅指定 Node、官方 SDK、真实 CLI、项目、状态、独立历史和专用环境，不允许替换 worker 或代理。旧 `DF_SDK_CONFIG` 和 `DF_SDK_WORKER_ENTRY` 不再作为部署入口。

`files.rs` 使用异步文件检查和既有有界配置读取。worker/dist 必须包含非空普通文件 `index.js`、`probe.js`、`protocol.js`、`sdk.js`、`shutdown.js`，各成员最多 256 KiB；缺目录、缺成员、链接、错误类型或超限均返回有限未准备错误。未准备状态不启动 worker，不自行下载、安装或改变提供者。

便携原生包若将可执行文件放在 `bin/`，则实际配置、配置模板和 `worker/dist` 同样放在该 `bin/` 目录旁。插件根 `package-assets.json` 通过通用静态成员映射声明五个 JS、`worker/package.json` 和 `worker/package-lock.json`；不声明依赖目录、真实配置或凭据。公开安装器已保留包内成员，不需要由业务请求提交服务器路径。打包器必须携带真实构建后的五个 JS 文件；只有源代码或模板不能表示已具备运行入口。官方 SDK 完整包、Node 和真实 CLI 继续按既有运行时准备与部署配置管理。

`tests.rs` 回归部署参数不能替换 worker、旁置配置与显式配置读取、缺成员/空成员/错误类型/超限的明确失败，以及官方 SDK 和 CLI 的配置映射保留。真实服务从不同工作目录启动、在线包安装与正式 npx 分发另行验收。
