# 安卓 APKS 安装公开接口消费合同

日期：2026-10-10。依据[后端实施裁定](../../../backend/docs/implementation/安卓APKS安装插件实施裁定.md)与当前公开设备、产物和任务源码，只冻结前端消费要求。本批只写本文，不修改源码、生成类型、配置或产品界面，不运行门禁；插件实施、宿主装配撤除及实际服务验收由主代理另行记录。

## 选定消费路径

现有 SDK v2 与 HTTP v2 可直接复用：先上传原始 APKS 取得产物 ID，再从当前设备目录取得完整引用，最后通过公开 `device-actions` 执行精确能力 `app.install_apks@1`。不增加 SDK 版本、APKS 专用路由、工具路径输入或浏览器平台分支。

| 阶段 | 既有公开入口 | 消费要求 |
| --- | --- | --- |
| 上传 | `HostContext.artifacts.upload(filename, Blob, signal)`；`POST /api/v2/artifacts?filename=...` | 保留原始 APKS 字节和显示名，保存响应产物 ID 与真实 `logId`。上传成功只表示产物可供任务引用 |
| 提供者与观测 | `devices.refreshProviders/refreshDirectories/refreshProvider`、`snapshot` | 取真实当前代的 `providerId/generation/localId`；发现尚无目录时先刷新，不猜测 serial 或借用前代目录 |
| 能力准入 | 当前提供者定义和设备能力 | 精确匹配 `app.install_apks`、版本 1、`scope=device`、`access=write`；设备须为 `online` 且该能力可用。平台名称或旧操作名称不替代准入 |
| 提交 | `HostContext.devices.invoke(action, signal)`；`POST /api/v2/device-actions` | `deviceId` 使用当前引用的 `localId`，业务 `input` 仅为 `{artifact_id}`，取得公开 Job ID 与响应 `logId` |
| 结果与历史 | `getJob/cancelJob`；可选 `taskHistory.get/list/events`；既有 jobs 接口 | 保留真实状态、结果、错误及每次查询的日志 ID；目录失效或提供者换代不改写已持久化历史 |

SDK 动作形状如下，只说明既有公开参数，不是新实现或接口模式：

```typescript
{
  providerId: reference.providerId,
  generation: reference.generation,
  deviceId: reference.localId,
  capability: 'app.install_apks',
  version: 1,
  input: { artifact_id: uploadedArtifact.id }
}
```

[device-gateway.ts](../../src/app/device-gateway.ts) 已显式映射为 HTTP 的 `provider_id/generation/device_id/capability/version/input`。插件执行封套 `{device_id,input:{artifact_id}}` 和嵌套产物授权由宿主生成；浏览器不把封套重复放进 `input`，不发送 `/input/artifact_id` 授权对象或服务器文件路径。

## 产物和设备资格

输入为一个上传产物：标准连字符 UUID、合法单文件显示名、大小写不敏感的 `.apks` 后缀、最多 64 MiB；插件要求一个且仅一个与业务 ID 一致的 `/input/artifact_id` 授权，并核验完整大小与 SHA-256。浏览器可提前提示明显不符合的选择，但最终资格由宿主与插件确定，不能用前端检查替代实际副本与包校验。

APKS 外层规则由现有公共包库执行，包括非空 `toc.pb`、至少一个带 ZIP 标识的 APK、条目身份/长度/CRC 和展开限额；设备匹配交给部署者配置的 bundletool。规格分包提取产生的普通 ZIP 没有 `toc.pb`，不能替代原 APKS 调用本安装能力。前端不新增设备规格、模块、降级、签名、Java/JAR、ADB、临时目录或任意工具参数。

动作前和回执交付前的身份检查沿用 [devices/rules.ts](../../src/features/devices/utils/rules.ts) 与 [devices/index.ts](../../src/features/devices/index.ts)。旧代、无本代观测、离线、未授权、能力缺失或版本不符均按现有规则拒绝；刷新或重载不能自动把保留引用换成新代。新动作必须由调用方重新选择真实当前引用。

## 120 秒期限与同设备写入

能力声明 `execution_timeout_ms=120000`，公开 SDK 映射为 `executionTimeoutMs`。该值是宿主使用的总预算元数据，浏览器只读取，不传请求覆盖，也不把每一步或每次查询重新计为安装的 120 秒。

迁出后，排队、同设备写锁、握手、配置、副本、包校验、Java 执行与结果处理共用同一次原始截止点 `D`，协议 4 插件使用对应的本地单调截止点 `D_L`，不续期。锁等待也消耗预算。前端取消等待或开始新的历史查询不改变服务器原任务期限；取消后不自动重提安装以取得新预算。

安装复用宿主 `(provider_id,local_id)` 的跨代身份锁，与该提供者同设备的 APK 安装、截图、输入、卸载等写动作串行；不同设备可并行。旧 alias、直接贡献和公开设备动作共用此规则。浏览器不加一把被当作服务器互斥依据的本地锁；不同提供者映射到同一物理设备的协调不在本合同内。

## 成功结果的准确边界

插件业务值固定为 `{artifact_id,device_id,installed:true}`，不输出新产物或工具诊断。公开设备动作和直接插件贡献的成功 Job 保留插件 `result/artifacts` 包装：业务值在 `Job.result.result`，产物数组为空。只有已配置的旧 alias 才按其 `value/wrapped:true` 映射返回原三字段结果；不能给全部 Job 增加统一的盲目解包规则。

消费方应确认 Job 终态为 `succeeded`，再校验实际业务值的字段与输入产物、设备身份一致，且 `installed === true`。Job 提交成功、上传成功或 JSON 可解析均不等于安装成功。既有 `publicJob` 只保持合法 JSON，不代替这项业务校验；本批没有新增该消费实现。

`installed:true` 仅表示固定安装工具调用按既有规则完成。bundletool 零退出且两流合并诊断不含冻结失败子串即可接受，空输出允许，不要求 APK 安装的独立 `Success` 行。前端不另行按工具文本判断成功，也不将该值解释为应用已启动、包真实性/签名已全面确认、业务可用或真机验收通过。

## 取消、卸载与历史

caller 取消、浏览器插件/面板退出、宿主实例关闭均沿用现有作用域信号合并，结束等待并撤销旧结果交付资格。`AbortSignal` 不等于服务器 Job 取消，也不证明安装回滚或工具副作用停止。已有 Job ID 时，需要取消服务器任务应显式调用 `cancelJob(id, signal)`，再以仍有效的新查询信号读取真实终态；不得沿已取消的信号继续重查。

提供者卸载或重载撤销当前贡献与旧代引用，在途任务如何收口以服务器实际记录为准。不能强行把取消后的任务改写为 `cancelled`：任务可能已提交成功，也可能因超时、依赖或清理失败成为 `failed`。卸载后历史仍通过既有 `getJob/taskHistory.get/list/events` 读取，不以当前操作目录或新代设备定义补写历史来源、期限、输入和结果。已卸载浏览器插件的旧上下文不能继续调用；历史查询由仍存活的宿主或新挂载取得公开引用。

插件的直接 Java 客户端、文件工作和私有目录收口不代表 bundletool 全部派生进程、共享 ADB server 或设备事务均已恢复。未确认清理须保留 `cleanup_failed` 语义，不把目录保留视为“可继续安装”，不在浏览器触发删除服务器临时文件或自动重试。实际设备状态须另行核验。

## 错误与日志 ID

沿用公开 `HostError` 与 `HostResult.logId`，保留每次真实响应的关联信息：

- 本地输入、身份、能力版本或观测资格拒绝可能产生 `invalid_input/not_found/conflict`，`logId=null`；没有 HTTP 的请求不得伪造日志 ID。
- 服务器拒绝保留实际 `code/status/logId`；依赖配置、包资格、超限、期限和 `cleanup_failed` 按服务实际响应区分，不把所有失败统一解释为 APKS 不兼容。
- Job 提交或查询 HTTP 成功但任务终态为 `failed` 时，保留原 `Job.error/result` 和该次响应的 `logId`。查询日志 ID 只关联这次查询，不冒充原执行日志；Job ID 也不能替代日志 ID。
- 已取得响应后生命周期撤销，继续保留可用的真实日志 ID，但旧回执不能回写当前目录或新挂载。预取消、网络失败和本地资格拒绝不生成假的服务日志。

安装没有新产物，失败任务也不应从响应中猜测工具输出文件。历史任务错误文本不自动转换为新的 `HostError.code`，也不根据错误文本重放非幂等安装。

## 宿主装配撤除后的消费变化

| 原行为 / 配置 | 本批裁定后的要求 |
| --- | --- |
| 宿主生产装配 `InstallApksOperations` / `AndroidSplits` 安装侧车 | 新安装来自真实已部署的 `android-device` 能力；空插件宿主不内建旧安装贡献 |
| `APK_ADB/APK_JAVA/APK_BUNDLETOOL_JAR` 选择安装工具 | APKS 工具属于插件旁置部署配置；浏览器不设置环境变量或传工具路径。其他用途的部署字段是否仍保留由相应宿主装配决定 |
| `android.app.install_apks` 随内置操作出现 | 仅在显式格式 2 绑定及真实目标可用时出现；严格输入仍为 `{artifact_id,device_id}`，原 ASCII serial 资格不扩大 |
| 旧名或平台字符串存在即可提交 | 必须按实际目录发现；目标缺失、卸载或旧代时停止提交，无内置侧车、普通任务或任意 shell 回退 |
| 原 APKS 专属同实例设备锁及安装端口重新计时 | 统一设备写锁与原 `D/D_L`；新增当前代、已观测、online 和能力可用准入，属于明确的行为收紧 |

纯包 `extract_splits` 仍属于 `android-packages` 的普通任务，不要求在线设备，不能因本次安装迁出而改用 `device-actions`。旧 [APKS 设备匹配接口说明](../../../backend/docs/contracts/APKS设备匹配接口.md) 的宿主环境与专属锁段落保留其原实现语义；本批新安装消费以实施裁定和本文为准。源码撤除、兼容绑定及部署实际结果查主代理记录，本文不把目标裁定当作撤除已通过。

## 可复用模块与交接范围

| 已有模块 | 本批复用 |
| --- | --- |
| [plugin-sdk/devices.ts](../../src/plugin-sdk/devices.ts)、[app/device-gateway.ts](../../src/app/device-gateway.ts)、[features/devices/index.ts](../../src/features/devices/index.ts) | 能力元数据、精确身份、准入、提交与晚到回执撤销 |
| [plugin-sdk/artifacts.ts](../../src/plugin-sdk/artifacts.ts)、[app/artifact-gateway.ts](../../src/app/artifact-gateway.ts)、[plugins/artifact-access.ts](../../src/plugins/artifact-access.ts) | 原字节上传、公开产物 ID、生命周期与真实日志传递 |
| [plugin-sdk/task-history.ts](../../src/plugin-sdk/task-history.ts)、[features/tasks/index.ts](../../src/features/tasks/index.ts) | 已提交 Job 查询/取消、历史和状态事件；状态事件不是工具诊断流 |
| [plugins/device-access.ts](../../src/plugins/device-access.ts)、[plugins/scope.ts](../../src/plugins/scope.ts)、[app/public-api.ts](../../src/app/public-api.ts) | 可选设备入口、嵌套作用域、取消与错误映射，不依赖 UI 框架 |

最小后续真实消费验证为：原 APKS 上传及日志 → 当前代在线目录的精确能力 → SDK/HTTP 安装及原结果包装 → 失败日志 → caller/挂载取消与服务器显式取消的区别 → 卸载/重载拒绝旧引用但保留历史 → 原 `D` 内锁等待与工具收口。主代理统一执行实际插件/宿主版本、debug/release 和分发验证；本文不产生新的通过记录。

上述公开消费与 React/Svelte 无关。具体界面、业务值校验实现、真实 APKS/Java/bundletool/ADB/设备、安装后应用状态、120 秒长执行及完整派生树仍需对应实施和运行证据，本批没有新增占位功能或界面。
