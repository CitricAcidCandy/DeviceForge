# DEX直接分析基础消费

## 当前目录分层

根目录仅保留本说明与 `index.ts` 公开门面，外部应用按门面消费。原用例实现从根索引迁入 `application/`，原导出保持兼容。已有算法行为与协议保持，内部文件路径已按职责整理。

- `application/`：用例、状态、目录与生命周期编排；HTTP装配工厂也放在此层，基础设施不反向依赖用例。
- `domain/`：纯业务规则、输入及结果验证、数据模型与转换；不依赖其他内部层。

允许依赖为 application → domain/infrastructure，infrastructure → domain，ui → application/domain；domain 不依赖用例、适配或界面。纯规则现有共享API类型和错误保留过渡，不新增HTTP调用。

本模块消费独立DEX插件的两项公开普通Job贡献，不提供产品UI、DEX解析器、反编译器或SDK版本识别。业务解释类型仅属于本feature；已有Operation、Job、产物和HTTP包装仍索引生成契约，不定义重复公共DTO。

## 文件职责

- `types.ts`：DEX业务输入、统计、完整性和SDK证据的解释类型，以及动态操作目录的只读快照。
- `rules.ts`：规范产物UUID、UTF-8字节长度、严格SDK规则及冻结副本。
- `catalog.ts`：公开动态目录读取与准入，目录取消、替代和销毁保护。
- `results.ts`：空产物包装、来源回显、统计几何、版本、完整性和逐规则证据校验。
- `index.ts`：基于shared/jobs的提交、恢复、查询、显式取消和销毁；HTTP工厂复用已有公开端点。

## 公开用例

`createDexAnalysis(jobGateway, operationReader, options)`注入既有Job网关与公共操作目录读取器；`createHttpDexAnalysis(client, options)`通过统一客户端调用`/api/v2/operations`与Job端点。所有异步调用要求显式`AbortSignal`。

| 用例 | 行为 |
| --- | --- |
| `refreshOperations`、`snapshot` | 显式刷新并冻结本模块两项真实公开贡献，不返回无关操作 |
| `inspect` | 提交`plugin.dex-analysis.inspect`，仅接受artifact_id |
| `scanSdks` | 提交`plugin.dex-analysis.scan_sdks`，增加1至100条严格规则 |
| `resumeInspect`、`resumeScanSdks` | 用原Job票据与原输入读取历史任务，不重提交 |
| `queryJob`、`cancel` | 只接受本模块两项操作票据；取消为显式服务器动作 |
| `dispose` | 撤销本地目录与Job等待，不自动取消服务器任务 |

新提交前必须显式刷新公开操作目录。刷新开始清旧目录，失败、取消、卸载后空目录不保留内置操作回退。目录只是本地观测，不提供服务端代际租约或原子准入；远端变更须再次刷新，服务器仍可拒绝已失效操作。历史任务恢复、查询和取消不要求插件仍在目录中。

## 输入与结果边界

产物ID规范为小写UUID，不接收服务器路径或输出目录。SDK规则只含name、点分package_path与可选class_name；按后端Rust规则核对UTF-8字节上限、Unicode空白、控制字符及ASCII包/类标识。名称唯一，内部类保留`$`。省略class_name在发送副本中显式规范为null，不修改调用者输入；规则与结果均递归冻结。

只消费宿主直接操作的`{result,artifacts:[]}`包装，两项贡献均不发布产物。结果回显原artifact_id，版本限定035、037、038、039及040；file_size为112至64MiB。六项counts校验安全整数、表限额、定义类不超过类型、类型不超过字符串，以及主索引表最小字节范围。三项integrity必须分别明确为true，不把这三个观测改称完整Android验证通过。

SDKfindings按原规则顺序逐项关联。证据仅为无`L`/`;`包装的定义类路径，不带`.smali`后缀；前缀要求完整`/`包边界。每规则最多10项，唯一且按Rust的UTF-8字节顺序排序；补充平面字符不使用JavaScript UTF-16排序。证据名称遵守后端已冻结的DEX SimpleName范围，040才接受新增空格字符，保留内部类`$`。

package_found与非空证据一致；指定class_name时class_found须与精确目标证据一致，未指定时须为null。跨规则证据并集不得超过defined_classes，累计按后端保守JSON转义算法不超过512KiB。只引用外部type_ids时可返回未命中，本模块不根据types数量推测SDK存在。

## 取消与验收

任务提交、轮询、恢复、终态失败及日志传播复用共享JobRunner。取消客户端等待不自动cancel或重提交；已有JobID的等待失败保留恢复票据和原提交日志。恢复结果仍以原artifact_id与原规则核对，不能用另一份规则解释旧任务。下游忽略信号时等待及时结束，销毁后拒绝晚到结果及后续入口。

定点Node测试证明注入HTTP端点、动态目录、规则、五版本统计、来源、包装、证据、Unicode排序、保守体积、恢复与取消行为；TypeScript和架构检查结果在本批交接中另记。没有实际解析文件或重算DEX摘要，也没有真实Rust服务上传DEX、正式包/npx、真实应用DEX、浏览器或跨平台证据。宿主当前DEX产物资格仍是独立接缝，不把注入测试当作真实上传及消费完成。
