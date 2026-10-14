# 工具供应业务用例

## 当前目录结构

2026-10-14按用户最新约束采用 Ant Design Pro 风格的功能组织。此前 domain/application/infrastructure/ui 方案已被覆盖，不再作为当前目录约束。根 `index.ts` 保留核心公开API且不加载TSX，目录仅按实际职责创建。

- `models/`：用例、状态、订阅、轮询与会话控制；HTTP工厂在此组合注入的服务。
- `utils/`：纯规则、转换、结果验证和计算，不依赖models、services或components。
- `types/`：业务模型与端口类型；保留已有共享契约类型。

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
