# 工具供应业务用例

## 当前目录分层

根目录仅保留本说明与 `index.ts` 公开门面，外部应用按门面消费。原用例实现从根索引迁入 `application/`，原导出保持兼容。已有算法行为与协议保持，内部文件路径已按职责整理。

- `application/`：用例、状态、目录与生命周期编排；HTTP装配工厂也放在此层，基础设施不反向依赖用例。
- `domain/`：纯业务规则、输入及结果验证、数据模型与转换；不依赖其他内部层。

允许依赖为 application → domain/infrastructure，infrastructure → domain，ui → application/domain；domain 不依赖用例、适配或界面。纯规则现有共享API类型和错误保留过渡，不新增HTTP调用。

`createToolSupply` 消费 `plugin.tool-supply.catalog/plan/install/remove`。`rules.ts` 校验业务模块 ID 和不重复的有界选择；`results.ts` 校验已安装与可用版本、计划下载量、安装摘要和移除结果；`index.ts` 负责真实任务执行、各操作恢复及显式取消。

目录查询保留 `source_error` 和本地 `local_only` 项，使清单不可用时仍可展示已安装工具。计划校验每个选中模块、版本与动作关系、入口状态及真实下载总量；空选择表示规划清单全部模块。点分数字版本以 u64 精度比较，缺失段补零。安装不会自动覆盖 `local_newer` 或重放失败任务；`changed:true/false` 都必须消费实际返回的版本与 SHA-256。产物源、程序和安装位置由后端部署配置决定，业务输入只有模块身份，前端不接收服务器路径。

事务观测以 `query(ticket, signal)` 返回的真实 Job 为准，安装成功以 `install/resumeInstall` 返回的实际结果为准。没有独立事务状态操作，也不生成回滚成功标志；`failed/cancelled` 和事务收尾失败原文保留，不推断安装目录已经恢复。`cancel` 返回仍为 `running` 时继续查询或恢复原任务，不能重新安装来代替状态确认。

宿主注入公开三个任务方法或共享 HTTP 任务适配器。所有结果保留任务和日志。取消等待与显式服务器取消分别操作；取消响应未到终态时需要恢复查询。当前是框架无关业务用例，不代表真实网络下载、回滚、产品页面或视觉验收通过。

## 运行时功能查询与准备

`runtimeFeatureStatus(featureKey, signal)` 与 `prepareRuntimeFeature(featureKey, signal)` 分别消费 `plugin.tool-supply.runtime_feature.status/prepare`，输入仅含 `feature_key`。功能标识为非空、有效 UTF-8 的 1–128 字节字符串，不套用模块 ID 的字符、长度或保留名规则，不修剪或规范化用户标识。`feature-rules.ts` 校验输入，`feature-results.ts` 严格解码结果，`feature.ts` 复用本实例共享任务运行器。

状态保留清单版本及脱敏来源错误：未知功能返回有效快照、空模块、`found=false/ready=false`；来源失败且无缓存返回空版本、非空错误和空模块，缓存成功则保留有效版本、来源错误和真实匹配项。本地安装错误继续以失败任务呈现。匹配项最多 128 个、模块身份唯一、全部为同功能归属的 `runtime`，拒绝 `local_only`、未知字段及版本动作矛盾。仅非空匹配全部为 `current` 且入口存在时 `ready=true`；`local_newer` 不等价于就绪。

准备成功必须返回相同功能标识、非空清单版本、`ready=true` 和 1–128 个唯一模块的真实版本、SHA-256 与 `changed`。保持服务器清单顺序，不补造路径、凭据或功能映射。安装条目没有功能字段，前端只能验证顶层功能身份及条目格式，不能另证每项属于后台同一清单快照。准备由后端单次清单快照和顺序安装负责；部分失败保留已提交模块，前端不逐模块提交、不自动重试、不推断全量回滚。状态资格不等于重新哈希全部文件或实际 SDK 可执行。

`resumeRuntimeFeatureStatus(ticket, featureKey, signal)` 和 `resumePrepareRuntimeFeature(ticket, featureKey, signal)` 只查询原任务，不重新提交；错操作票据及错功能结果受控拒绝。`query/cancel` 同时接受原四操作与两项运行时功能票据。取消等待不等于服务器取消，显式取消返回在途状态后仍须查询或恢复；失败、取消及未确认清理保持共享 Job 的实际状态和日志，晚到响应不能复活已经撤销的等待。

新增消费测试位于 `tests/tool-supply-feature.test.ts`，覆盖 Unicode 字节边界、非法输入零调用、未知与来源失败、多模块不变量、票据身份、日志、取消和恢复。当前按协作限制未执行生成、格式化、测试、构建或服务；门禁由主代理授权后统一执行，不借记旧批通过。

## 来源快照与旧插件兼容

五项来源操作外层消费 `manifest_source/manifest_sha256/source_error/manifest_version`，`source-result.ts` 只负责完整组及三态关系校验。`live` 要求有效摘要、非空清单版本与空错误；`cache` 要求有效摘要、非空版本及真实非空来源错误；仅目录及功能状态可返回来源、摘要、版本全空且错误非空的降级查询。摘要保持服务器原值，不把版本号当快照身份，不把缓存视为离线归档或真实 SDK 执行证明。

旧插件两个来源标记全缺时沿用原校验并返回原形状；仅 `manifest_source/manifest_sha256` 任一自有字段出现触发完整组校验，`manifest_version/source_error` 不单独触发，不能补造来源或摘要。单模块安装外层使用 `ToolInstallResult` 新增清单版本与来源组，准备子项继续使用原四字段 `ToolInstallation`，禁止下沉元数据、功能标识或服务器路径。来源错误不触发自动重提，恢复仍查询原 Job 并保留提交及查询日志。

来源兼容测试为 `tests/tool-supply-source.test.ts`，原两份测试不变。本批未自行执行门禁，写集冻结后交主代理串行验收。详细契约与定点建议见 `docs/工具来源缓存消费.md`。
