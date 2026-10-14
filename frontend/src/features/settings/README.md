# 设置业务用例

## 当前目录分层

根目录仅保留本说明与 `index.ts` 公开门面，外部应用按门面消费。原用例实现从根索引迁入 `application/`，原导出保持兼容。已有算法行为与协议保持，内部文件路径已按职责整理。

- `application/`：用例、状态、目录与生命周期编排；HTTP装配工厂也放在此层，基础设施不反向依赖用例。
- `domain/`：纯业务规则、输入及结果验证、数据模型与转换；不依赖其他内部层。

允许依赖为 application → domain/infrastructure，infrastructure → domain，ui → application/domain；domain 不依赖用例、适配或界面。纯规则现有共享API类型和错误保留过渡，不新增HTTP调用。

本模块以 `plugin.settings.list/get/set/delete/import` 提交真实任务，并通过共享执行器等待终态。`rules.ts` 校验用户或工作区归属、ASCII 业务身份、规范十进制 u64 预期修订及 1–64 配置区导入；`results.ts` 校验结果版本、修订及配置区匹配；`index.ts` 组合公开用例、恢复等待和显式取消。

`createSettings` 注入公开宿主的 `submit/getJob/cancelJob` 或 `createHttpJobGateway`。写入、删除和导入必须携带服务器最后返回的修订，不自动覆盖冲突，不自动重放。恢复读取配置时同时传原配置区。配置内容保持 JSON 原值，不读取本机文件或服务器路径。结果携带真实任务、提交日志和最后查询日志。

成功任务无条件消费 `{result,artifacts}`，本模块目前没有文件输出，产物数组须为空；缺失配置区是任务业务失败，不能补成空配置。

`remote.ts` 消费旧服务兼容贡献 `remote.load/remote.save`，配置区限定为后端公开的 12 名，两项均携带预期修订。读取远端不可用时返回 `source:local` 原备份，必须保留 `remote_committed:false`、`backup_updated:false` 和本地修订；这不表示远端保存失败后回退成功。保存失败是任务失败，不自动重试。远端成功但本地 CAS 或备份提交失败保留 `backup_updated:false` 和 `revision:null`；只有实际远端保存成功为 `remote_committed:true`，读取成功仍为 `false`。服务地址和请求头只由后端部署配置管理，前端只提交业务区名与 JSON 内容。

`query` 可以读取本模块原任务状态；`resumeRemoteLoad/resumeRemoteSave` 恢复原任务终态等待并校验原配置区，不再次访问或保存远端。显式 `cancel` 只消费当次真实 Job 状态，不能据取消等待判定远端未写入。成功与失败日志分别由共享任务接缝保留。

`remote.ts` 导出 `RemoteSettingsWrite extends SettingsWrite`，仅 `saveRemote/resumeRemoteSave` 接受可选布尔字段 `write_local_backup`。省略时请求中不补字段，保持后端原默认行为；显式 `true/false` 原样传递。字段存在时只接受布尔值，`undefined`、`null`、数字、字符串及其他非 JSON 输入在提交前拒绝；普通 `set/import/loadRemote/resumeRemoteLoad` 不接受该字段，普通配置内容中的字符串语义不变。

例如 `saveRemote({...input, write_local_backup:false}, signal)` 显式关闭本地备份；该开关不改变远端保存操作，前端仍只提交一次原 `remote.save` 任务。此时成功结果保持 `remote_committed:true`、`backup_updated:false`、`revision:null`，若服务器返回 `backup_updated:true` 则按协议错误拒绝并保留该响应日志。开关为 `true` 或省略时，远端成功而本地备份失败的原结果仍有效，不将备份失败解释为远端未提交。`resumeRemoteSave(ticket, input, signal)` 应携带原开关，仅查询原 Job，不再次提交远端保存；提交结果未知时不自动重试，取消和晚到响应沿用共享执行器。

当前提供框架无关用例及目标协议测试；产品页面、视觉布局和实际后端持久化由宿主集成后单独验收。

旧备份通过 `importLegacy({scope, owner_id, expected_revision, files:[{name,text}]}, signal)` 显式导入。`legacy.ts` 只转换调用者选择并读入的文本，固定接受deviceInfo、packageInfo、iframePageUrl、permissions、luaCommand、dynamicSnalysisHooks对应JSON文件，以及映射到packageSDK的packageSdk.json。未知或重复文件、非法JSON整批拒绝，成功后仅一次现有settings.import提交；归属和CAS修订必须由调用者明确提供，不扫描服务器目录、不自动重试冲突。

`parseLegacyEditorText` 只为明确的旧编辑器文本兼容入口解析一次，结果可交给现有set或remote.save；JSON字符串、null及未知业务字段保持原值。普通set/import/remote.save不自动解析字符串。文件选择界面、旧真实配置样本及真实服务器持久化另行验收。
