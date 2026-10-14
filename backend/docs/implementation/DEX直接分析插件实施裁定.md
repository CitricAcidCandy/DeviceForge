# DEX直接分析插件实施裁定

日期：2026年10月12日。后端开发独占`backend/plugins/dex-analysis/`与本文；主代理负责workspace、架构、生成、宿主别名和集成门禁。本批不等待终端、Harmony截图或输入的整批验收。采用architecture-first、Hybrid，先冻结以下输入与责任，再实现。

## 范围与证据

迁移清单的APK分析仍缺DEX直接分析。旧`src/main/ipc/handle/apk_parse.ts`和`src/main/ipc_handler/apk_parse/index.ts`已读取，仅有Apktool调用和smali路径检测，没有直接DEX解析器。新能力是独立进程插件，普通协议4，贡献`inspect`与`scan_sdks`；完整ID为`plugin.dex-analysis.inspect`和`plugin.dex-analysis.scan_sdks`。不修改旧工程或现有七项包插件。

格式依据为Android官方[DEX格式](https://source.android.com/docs/core/runtime/dex-format)，本次已实际读取版本、头、MUTF-8及摘要说明。支持单一标准DEX的035、037、038、039和040，固定112字节头、little-endian；明确拒绝036、041容器、Compact DEX、reverse-endian及非空链接区。本阶段不反编译Java、不执行或解释代码指令、不校验全部代码、注解或编码数组语义，不声明等同Android完整DEX验证器。

## 输入、输出与限额

主代理集成后实际库26/26通过，全目标Clippy与debug构建退出0。首集成20/26的六失败来自协议4测试夹具误把最终响应当顶层Response；只修测试为公开CooperativeResponse嵌套形状后全通过，生产未改变，首失败原件保留。

本轮真实服务7检查/5Job通过，原件`artifacts/dex-analysis-service-debug-b0d929ff-5deb-4798-a2b9-a8099f8b6330/report.json`：真实前端公开inspect/scan用例、上传/两版本原字节、MCP提交两贡献、Adler32失败、卸载撤销与原MCP历史恢复、关联日志及输入身份。宿主上传与插件输入白名单接缝另见[DEX产物资格接缝](DEX产物资格接缝.md)。release、正式分发、真实APK/DEX和真机仍待，不用库或debug证据替代。

业务仅接收规范UUID的`artifact_id`；`scan_sdks`另接1至100条唯一名称的`rules`，每条固定`name`、点分`package_path`及可选`class_name`，拒绝未知字段。输入必须是宿主授权唯一`artifact_id`关联的普通`.dex`文件，不能传服务器路径、工具、环境或输出目录。不发布产物。总预算30000毫秒，所有读取、摘要及解析沿公开InvocationContext原截止点。

单文件最多64MiB，每次读取/摘要分片最多64KiB。字符串最多1000000项、类型/字段/方法/原型各最多65535项、定义类最多65535项；单字符串最多65536个UTF-16码元且最多196608编码字节，作为名称引用时最多4096码元，类型名称缓存合计16MiB。SDK规则最多100条，每条证据最多10项。结果只返回统计和有界SDK证据，不返回全部字符串、全部类或输入原字节。

`inspect`返回版本、实际文件字节数、头部表计数、已定义类数量及`integrity:{artifact_sha256, dex_sha1, dex_adler32}`成功观测。验证头部固定大小/版本/端序/实际长度、声明区段与映射边界、头部六类主索引表的范围/引用/排序、已定义类描述符及MUTF-8；SHA-1签名按字节32至EOF，Adler32按字节12至EOF，宿主SHA256按完整输入。调用点、方法句柄及其它数据条目只保留映射范围观测，不校验其内部索引或全部字节码语义。

`scan_sdks`返回原规则、`package_found`、`class_found`及排序证据。只匹配`class_defs`实际定义的类，不把`type_ids`中的外部引用判成SDK存在；包前缀必须完整分隔符边界，内部类保留`$`，未指定类时`class_found:null`。指定类的命中证据优先保留。结果不证明SDK版本、运行状态或代码行为。

SDK结果按保守JSON转义体积累计最多512KiB，超过限额返回有限失败，不截断证据后假装完整成功。一般字符串允许MUTF-8孤立代理码元，作为类/成员名称引用时必须能解为合法Unicode名称；040新增空格范围按官方SimpleName表处理。

## 职责与资源

| 单元 | 输入、输出及责任 | 副作用与边界 |
| --- | --- | --- |
| `input` | 严格业务和宿主授权关联 | 不读文件或选程序 |
| `source` | 普通文件原字节、有界读与SHA256 | 同步I/O只在受限worker，拒绝链接/重解析路径 |
| `dex/header`与`dex/strings` | 头、表、映射、MUTF-8和索引 | 纯字节解析，按原控制点检查 |
| `dex/classes`与`findings` | 已定义类和包边界证据 | 不读取代码、网络或部署配置 |
| `worker` | 原截止点、取消、真实物理返回 | 每进程最多一个worker；File与许可持有到返回 |
| `lib/main` | 公开协议4薄装配与有限错误 | 不依赖宿主domain/application/infrastructure/server |

生产依赖为公开SDK、plugin-runtime、android-package-core的Control、Serde、Tokio及有限错误；新增`sha1 0.10`遵循DEX指定算法，`sha2 0.10`与当前包插件版本一致。不自行实现SHA-1，不增加平台进程或私有JSON通道。

取消/到期先发只读控制信号，再沿一次最多两秒清理点等待真实worker返回，不重新授予业务预算。Drop、panic或清理超窗保留Failed；没有物理返回证据不能报告Complete。无临时目录、输出文件或外部工具，宿主输入副本由宿主原生命周期持有，插件不删除它。

## 验证与交接

生产和回归分批写入；主代理接收冻结后执行定点Cargo、架构和集成门禁。回归必须包含独立有效样本、篡改摘要、坏长度/区段/索引、非法MUTF-8、版本拒绝、只引用未定义的类、包前缀边界、证据上限与预取消/到期。库测试、协议/服务、正式包/npx和真实DEX分别记录；普通缺陷集中回流，研发继续下一独立项。

## 本批冻结状态

生产、公开清单、中文README及26项库内回归已写完，尚未运行Cargo编译或测试。回归包括16项业务/独立手工DEX布局、3项MUTF-8直接样本、3项真实文件与公开协议4握手、4项worker期限/取消/Drop及许可物理释放。样本由测试独立写字节布局，不调用生产解析器生成；不把合成DEX等同真实应用DEX验收。

主代理先加入`plugins/dex-analysis`到workspace与独立插件架构规则，再执行`cargo test -p deviceforge-dex-analysis-plugin --lib`及本批定点Clippy/构建/格式检查。新增SHA-1依赖、宿主目录/别名、HTTP/MCP、前端用例、正式包/npx、实际应用DEX及跨平台分别待集成或验收。测试通过前只记已实现，不记已验证。

首次定点库运行20项通过、6项失败，原件为根`artifacts/dex-analysis-integrated-lib-20261012.txt`；共同原因是夹具将合作响应误当顶层普通响应。公开协议4最终帧为`{response:{protocol_version,request_id,result或error,...},cleanup}`。本批仅修夹具，以公开SDK的`CooperativeResponse`严格反序列化并核对嵌套身份，业务与worker断言沿同一封套读取；生产兼容、结果和清理语义不变。原失败报告保留，修后门禁由主代理另行执行和登记。
