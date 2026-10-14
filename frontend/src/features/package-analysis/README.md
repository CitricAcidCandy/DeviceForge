# 包分析基础用例

## 当前目录分层

根目录仅保留本说明与 `index.ts` 公开门面，外部应用按门面消费。原用例实现从根索引迁入 `application/`，原导出保持兼容。已有算法行为与协议保持，内部文件路径已按职责整理。

- `application/`：用例、状态、目录与生命周期编排；HTTP装配工厂也放在此层，基础设施不反向依赖用例。
- `domain/`：纯业务规则、输入及结果验证、数据模型与转换；不依赖其他内部层。

允许依赖为 application → domain/infrastructure，infrastructure → domain，ui → application/domain；domain 不依赖用例、适配或界面。纯规则现有共享API类型和错误保留过渡，不新增HTTP调用。

本模块消费 `plugin.android-packages` 的清单、签名、精确提取、构建、反编译、SDK 扫描和离线分包提取七项直接贡献。当前操作目录与部署决定入口是否可用；本模块不自动装载插件，不修改旧别名映射，也不提供具体业务界面。

## 职责与装配

`types.ts` 只读索引生成合同中的清单、签名与精确提取结果类型，以必要的类型组合表示插件实际结果。`rules.ts` 校验产物 UUID、模块及安全的精确 APK 条目，建立稳定输入副本；`results.ts` 校验直接贡献的宿主包装、业务字段与产物。后四项分别由 `extended-types.ts`、`extended-rules.ts`、`extended-results.ts` 和 `extended.ts` 承接，`apks-options.ts` 负责高级模块选择与安装输入的纯准备，`index.ts` 只作共享任务与下载能力装配。

通过 `createPackageAnalysis(jobGateway, jobOptions, artifactReader)` 装配。七项调用和恢复均要求显式 `AbortSignal`。任务网关可以复用 `createHttpJobGateway(client)`，下载能力可由宿主产物客户端注入；未装配下载能力时明确失败。

## 首三项合同

- 清单结果没有产物，核对源 `artifact_id`，保留完整 XML、字符串版本号、权限和显式 null。APK 的模块为 null 且不能接受模块请求；AAB 省略模块时结果须为 `base`，显式模块须匹配原输入。前端无法仅从产物 ID 预判文件格式，实际格式资格仍由服务器确认。
- 签名结果没有产物，核对源 `artifact_id`、成功验证状态、顺序完整的证书编号、SHA-256、唯一验证方案及至少一项已验证方案。证书 DN 可为 null，报告原文保留；前端不从报告文本重新推断或伪造验证结果。
- 精确提取只提交 `{artifact_id,entry}`。条目按 UTF-8 校验 5–500 字节，扩展名只作 ASCII 大小写匹配，拒绝绝对路径、父路径、空路径段、反斜杠、冒号及控制字符。条目原文和大小写保持不变；结果业务值只有 `entry`，宿主须发布唯一 `extracted.apk`，媒体类型为 `application/zip`，大小最多 64 MiB。

直接贡献返回 `{result,artifacts}`，旧 `android.package.*` 别名返回旧直接 DTO。本模块只消费直接贡献，拒绝将旧 DTO 当作插件包装。清单、签名没有格式版本字段，前端不补造。精确提取业务值没有源 ID 字段，因此只能核对条目及本任务发布的产物，不能从返回对象独立证明源 ID。

`download` 下载提取产物原字节，核对宿主发布的大小和 SHA-256，保留实际下载日志 ID；不在前端解析 ZIP、验证 CRC、验证签名或声明 APK 可安装。XML 和报告是业务字符串，未来展示应使用文本，不作为 HTML。

## 后四项合同

- `buildApks` 仅接受产物 ID 和 `default` / `universal` 模式。核对模式及有界 APK 数量，保留 `universal_entry` 的显式 null；Universal 必须恰好一个 `universal.apk`。Default 可以包含该条目，不能强制将其改为 null。唯一输出为 `built.apks`。
- `decode` 返回文件数和累计展开大小，文件数沿 Reverse 核心最多 10000 项且至少包含两个必要文件，展开大小最多 64 MiB；唯一输出为 `decoded.zip`。计数和发布不证明前端已读取或校验 ZIP 成员。
- `scanSdks` 接受 1–100 条唯一名称规则。名称按 UTF-8 校验不超过 100 字节，使用 Unicode White_Space 对应 Rust 空白语义；BOM 不作为空白删除。包路径和类名按真实 ASCII 标识校验。逐条核对返回来源、规则顺序、可空类名、包与类命中以及最多十条唯一 smali 路径证据；保留服务器证据顺序。路径命中不证明 SDK 版本、smali 内容或完整识别率。
- `extractSplits` 接受 snake_case 设备规格，复制 ABI / 本地化数组；列表非空、唯一且有界，密度和 SDK 为 1–10000 的整数。高级维度与模块选择见下文。结果规格须逐项保留原值及顺序，APK 条目非空、安全、唯一、最多 1000 项，并按核心要求使用小写 `.apk` 扩展名。唯一输出为 `selected-apks.zip`，不接设备安装参数。

四项基础结果类型继续只读索引生成合同，以 `Pick` 表示真实插件业务值；高级APKS字段作为本feature私有业务解释类型加法，不手写重复公共DTO或修改生成类型。结果不补造格式版本或源ID。构建、反编译和分包值不回显源ID，恢复必须携带原输入，前端无法仅从这些结果证明恢复输入的源产物身份。规则和规格使用独立副本，调用者后续修改不能改变请求与校验关联。

新产物由 `downloadBuilt`、`downloadDecoded`、`downloadSplits` 分别选择固定文件名，使用同一生命周期和原字节大小 / SHA-256 核验；媒体类型均为 `application/zip`，已发布产物最多 64 MiB。下载不进行重新编解码，也不替代实际 Android 工具或真实包验收。

## 高级APKS输入

设备规格可增加`device_features`和`gl_extensions`，各为0至256项唯一ASCII标识，每项1至160字节，只允许字母、数字、下划线、点、冒号及短横线；空数组沿服务器默认，null数组拒绝。`codename`与`device_tier`均为可空字符串，每项1至80字节，非空值只允许字母、数字、下划线及短横线，数字档位拒绝。四个数组及两个可选字符串的累计文本不得超过48KiB。

提取的`modules`和`instant`位于请求顶层，与device_spec并列。modules可省略或为null以保持旧默认；有值时为1至128项唯一模块，每项1至80字节，以ASCII字母开头，后续只允许字母、数字或下划线。`ALL`只能单独选择，不能与具体模块混用。instant为可选布尔值，缺省或false保持原流程；只用于离线提取。

未指定高级字段时仍发送原四维规格，不补空数组、null或false。已指定字段及模块数组建立冻结副本，保留顺序。后端device_spec输出会省略空数组和null可选值；结果核对时仅将这些默认等价形态对应，非空数组、具体代号和档位仍必须逐项匹配。

`prepareApksInstallInput({artifact_id,modules?})`只准备安装业务输入，由调用方放入公开设备动作的`input`字段，再经已有设备能力准入调用。直接插件封套同样将这份值放在`{device_id,input}`中的input内；modules不在封套顶层。助手不执行安装、不选择设备，不接instant、device_spec、服务器路径或device_id。安装与提取的模块规则一致。

提取结果仍只有device_spec和apk_entries，不回显modules、instant或sourceID。本模块不补造这些字段，也不能从返回对象独立证明模块选择、instant效果或来源；`toc.pb`匹配仍由实际bundletool及后端资格裁定。安装助手只证明合法输入准备，不能代表已安装、应用可启动或真机验收。

## 取消、恢复与证据

三项操作各自提供 `resumeManifest`、`resumeSignature`、`resumeExtractApk`，只读取并等待原 Job，不重发。恢复必须使用原输入；清单和签名可核对返回源 ID，提取结果不回显源 ID，因此同条目对应的另一输入不能由结果排除。

后四项提供各自的 `resumeBuildApks`、`resumeDecode`、`resumeScanSdks`、`resumeExtractSplits`。`queryJob` 和 `cancel` 限定本模块七项操作票据。取消等待不自动取消服务器任务，显式取消沿独立方法执行。`dispose` 撤销任务等待和所有下载；下游忽略信号时也不能交付晚到结果。提交日志、任务响应日志和下载日志分别保留。

本批先因缺少入口触发红测试，随后 14/14 定点测试通过。补充 Kelvin 字符的扩展名回归先复现 JavaScript Unicode 小写与 Rust ASCII 小写不一致，再修为明确 ASCII 匹配。修后定点仍为 14/14，`tsc --noEmit` 与 `check:architecture` 均退出 0，架构门禁覆盖 123 个源码文件。

后四项先以 13 项缺方法红测试确认入口缺失，再通过全部回归并补独立 SDK 规则副本验收；七项最终定点为 28/28，`tsc --noEmit` 和 127 源码的架构门禁均退出 0。首三项原 `types.ts`、`rules.ts`、`results.ts` 和测试保持冻结，入口与本文由七项最终版本接续。

高级APKS增量先以安装助手缺导出的红测试确认入口缺失，新增9项与旧28项共37/37通过；严格TypeScript与144源码架构门禁退出0，中文文档严格UTF-8及已有文件差异检查通过。此证据仅为注入式Job消费与纯输入准备，不包含真实bundletool、toc匹配、设备安装、浏览器或正式分发。

本代理未执行 API 生成器、全前端门禁、构建、真实 HTTP/MCP、实际 Android 工具或真机；这些证据由主代理分别协调。七项基础消费不能代表真实包兼容、设备安装、高级规格匹配、完整 APK 分析或完整重写目标完成。
