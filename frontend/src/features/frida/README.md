# Frida 业务用例

## 当前目录分层

根目录仅保留本说明与 `index.ts` 公开门面，外部应用按门面消费。原用例实现从根索引迁入 `application/`，原导出保持兼容。已有算法行为与协议保持，内部文件路径已按职责整理。

- `application/`：用例、状态、目录与生命周期编排；HTTP装配工厂也放在此层，基础设施不反向依赖用例。
- `domain/`：纯业务规则、输入及结果验证、数据模型与转换；不依赖其他内部层。

允许依赖为 application → domain/infrastructure，infrastructure → domain，ui → application/domain；domain 不依赖用例、适配或界面。纯规则现有共享API类型和错误保留过渡，不新增HTTP调用。

本模块消费六个真实贡献：`plugin.frida.server.deploy/server.status/server.run/processes/script.run/permissions.analyze`。`rules.ts` 校验设备、产物身份、100–120000 毫秒时长和结构化 Hook；`results.ts` 区分部署、观测、受控运行、进程枚举和脚本结果；`index.ts` 负责任务组合、上传、下载、恢复等待和显式取消。

`createFrida(gateway, artifacts, options)` 保留公开宿主三个任务方法与 `ArtifactAccess` 的既有注入语义。`createHttpFrida(client, options)` 新增真实生成端点装配，显式映射上传产物的 HTTP 字段与 SDK 元数据，不修改公开 SDK。六个业务方法仍使用原签名：deploy、status、runServer、processes、runScript、analyzePermissions。

业务请求固定为 `{device_id,input:{业务字段}}`，上传以产物 ID 引用，浏览器不传服务端路径或任意工具命令。脚本上传检查 UTF-8、空字节和 64 MiB 上限。任务成功结果严格消费 `{result,artifacts}`，拒绝未知顶层结果字段，校验 `operation.json`、`frida.log` 及脚本/通知文件、单个产物 64 MiB 上限；下载保持原字节，并核对大小和 SHA-256。

## 动态目录与生命周期

HTTP 工厂在新提交前要求显式 `refreshOperations(signal)` 并发现对应真实贡献。刷新开始清除旧目录，失败、取消和销毁不能恢复旧贡献；目录不代表服务器代际租约。`snapshot()` 提供不可变目录、刷新状态、日志 ID 与错误。既有直接 SDK 注入可以通过 `options.operations` 选择同样的目录门禁；未配置读取器时保留原注入调用语义，不把空目录宣称为可用目录。

六种 resume 方法、`queryJob(ticket, signal)` 和显式 cancel 只依赖真实任务票据，不要求插件仍在当前目录。取消客户端等待不自动取消服务器；`dispose()` 及时撤销忽略信号的等待、目录与下载，并消费晚到拒绝。输入、结果、产物与目录建立深冻结副本，调用者修改原数组不能改变在途请求或期望结果。

设备标识第一位必须是 ASCII 字母或数字，其余仅允许字母、数字、点、下划线、冒号或连字符，总长不超过 255。产物标识沿后端非空、不含控制字符且最多 128 UTF-8 字节的公开 schema，不额外强制 UUID；实际宿主能否定位该标识由公开接口裁定。权限模块最多 11 个且唯一，Hook 最多 256 条，参数最多 32 个；字符串沿后端 UTF-8 字节和控制符规则，拒绝孤立代理码元。Hook 的 module 可为空，未知字段和显式 null 拒绝。

## 清理与合同边界

状态观测是 `observed_only`，服务器运行只消费本次调用的 `invocation` 清理证据。脚本结果区分派生默认恢复和已运行目标；`direct_cli_confirmed` 仅证明直接 CLI 清理，`target_process_cleanup:not_claimed` 不得显示为目标进程停止。请求毫秒数与 CLI 向上取整的秒数分别校验，不把 CLI 时长写成毫秒精度。

部署、状态、有界服务运行和进程枚举的业务结果没有 device_id 回显；模块保留调用者提交的设备请求与任务票据，不补造结果设备身份或声称验证了真机。server.run 的 process_start_ticks 当前是 JSON u64 数值，前端只接受大于零的安全整数，超出 JavaScript 精度时拒绝；后端若需要覆盖完整 u64，须另做契约升级。

hook_summary 按后端原合同保留最多 4097 个不透明 JSON 诊断，脚本通知计数最多 10000。权限分析只要求某个真实诊断对象的 type 为 summary，不强制原合同没有冻结的细分字段、安装计数或一致性；不能用 summary 存在证明全部 Hook 安装或覆盖完成。自定义脚本通知文件也保留原字节，本模块不猜测其业务字段。

取消等待后用已知任务身份恢复，不重复部署或执行脚本。当前提供框架无关消费和目标测试；真实设备、Frida CLI、权限 Hook 效果、产品页面和视觉验收需独立完成。

## 当前增量验证

2026-10-12 原 5 项定点原件保留，新 HTTP、动态目录、严格输入/结果、冻结、取消恢复、下载与晚到回归 10 项通过，合计 15/15；TypeScript 严格检查退出 0，架构门禁 151 个源码文件退出 0。HTTP 使用真实客户端与端点适配器，但传输为注入夹具；不属于真实服务、浏览器、ADB/su/Frida 或真机证据。生成器、完整前端门禁、真实服务与正式包由主代理集成验收。
