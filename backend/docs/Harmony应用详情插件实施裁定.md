# Harmony 应用详情插件实施裁定

日期：2026-10-12。模式为 architecture-first，验证采用 Hybrid：先证明详情输入、固定参数和纯 JSON 保留，再验证独立协议、宿主共享任务与正式分发。本文为 `app.detail@1` 的批准实现依据，不表示门禁、服务、分发或真机已通过。

## 目标、旧行为与边界

独立 `harmony-device` 插件新增 `app.detail@1`，设备 API 3、`scope=device`、`access=read`、总预算 30000 毫秒。发现声明七项可用能力，双清单成为八贡献、七能力。旧工程 `src/renderer/ApkTool/src/script/deviceDebug/hdc/app.ts:44` 固定查询 `bm dump -n {bundleName}`，移除同包名标题后解析并返回完整 JSON；`:62` 仅在自动启动时另取 `hapModuleInfos[0].mainAbility`。旧源码形状不是真机输出证明。

只增加独立插件的详情业务，不修改公开 SDK、宿主路由或设备锁。查询成功表示 HDC 返回合法对象，不证明应用可启动、桌面变化或设备事务完成。模块选择、`mainElementName` 推导、连接、输入、常驻会话与真机继续独立交付。

## 选择与职责

选择拆分公共详情解析和启动能力推导；把全部详情约束为可启动首模块会拒绝合法不可启动应用，只返回能力名会丢失旧详情业务，均不采用。

| 单元 | 负责与输入输出 | 不负责 | 副作用 |
| --- | --- | --- | --- |
| `applications/models.rs` | 复用严格 `{bundle}` 输入 | 封套、工具、任务锁 | 无 |
| `applications/details.rs` | 字节和标题到完整 JSON 对象；对象到首模块能力名的独立规则 | HDC、宿主实体 | 无 |
| `applications.rs` | 固定查询 argv、详情与启停编排、原 `Control` 委派 | HTTP/MCP、清单、产物 | 既有公开工具调用 |
| `operations.rs` | 八短贡献、严格设备封套、委派应用模块 | 详情 JSON、能力推导 | 既有编排 |
| 发现、双清单与别名 | 七能力、八贡献和八旧名绑定 | 工具、内置回退 | 无 |
| 库和独立协议测试 | 输入、完整对象、固定 argv、失败与期限回归 | 宿主服务、分发、真机 | 假 HDC 独立进程 |

先拆纯 `details::parse` 与 `details::ability`，再复用一个详情查询编排。执行采用契约与回归先行的 Hybrid，不创建第二套进程执行器、缓存或宿主平台分支。

## 输入、命令与结果

设备封套严格为 `{device_id,input:{bundle}}`，拒绝未知、缺失、null 和错误类型字段。设备标识与包名继续复用既有最多 200 字节资格；包名为点分 ASCII 标识。固定独立 argv 为 `[-t,device_id,shell,bm,dump,-n,bundle]`，业务请求不选择工具路径或额外参数。

业务成功直接返回完整 JSON 对象 `Value`，保留未知字段、模块顺序与数组内容；不包装为 `{detail}`、`{output}` 或 `mainAbility`。宿主协议 4 沿既有 `{result,artifacts:[]}` 包装；格式 2 旧名 `harmony.app.detail` 通过 `device_capability` 指向 `app.detail@1`，`device_envelope` 转换平铺输入、`value` 与 `wrapped:true` 提取直接对象。

工具要求零退出、两流 UTF-8，每流最多 1 MiB。stderr 先检查既有失败诊断，包括大小写无关精确 `[Fail]`；stdout 仅允许纯 JSON 或首行精确 `${bundle}:\n` / `${bundle}:\r\n` 后的 JSON，不将合法 JSON 文本中的 `failed`、`error` 等普通字段当作诊断。未知标题、诊断前缀、尾随内容、重复键、非对象根及公开 codec 的 64 层/100000 节点超限均整份失败。

根 `name` 存在时须为请求包名；公开详情不要求 `hapModuleInfos`、首模块或 `mainAbility`，也不验证模块 `bundleName`。自动启动另行沿既有规则要求非空且最多 128 项模块、首模块对象、可选首模块 `bundleName` 匹配和合法 `mainAbility`，仍只选首模块，不因后续能力名不同拒绝。

## 期限、资源与验收

配置、HDC 查询、阻塞解析和结果发布沿同一协议 4 InvocationContext 原截止点、取消信号与 `Control` 租约。解析复用 `Control::work` 的 one-slot、有界阻塞工作及真实返回确认；完成后再次检查期限和取消。Future 丢弃、工作线程异常和未确认清理继续粘性失败及首次固定清理点，不延长预算或清理窗口。

详情不创建输入副本、私有目录或输出产物。固定错误不公开工具路径、原始诊断或部分对象；共享 HDC daemon 不由插件关闭。

最小证据依次为：纯输入/解析与自动启动保留回归；独立协议的固定一条查询、完整结果、UTF-8/退出/限额、取消和原期限；主代理串行门禁、HTTP/MCP 与旧绑定、热装卸/代际、日志、正式包/npx。模拟 HDC 不证明真机、派生树、daemon、设备状态或生产性能。库与协议新增源码交接后由主代理执行，不在角色内并行运行 Cargo 或服务。
