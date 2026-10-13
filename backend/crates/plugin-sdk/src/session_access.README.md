# 清单中的独立会话声明

`Manifest.sessions` 与 `PortableServerManifest.sessions` 为可选 `SessionAccess`，字段为 `protocol_version` 和 `operations: Vec<Contribution>`。省略或 null 均保持旧清单行为，序列化 None 不新增字段。顶层 `protocol_version` 仍声明普通任务协议 1–4；独立会话声明只接受版本 5，不改变已冻结的第五版帧。

`SessionAccess.output_retention` 是可选枚举 `SessionOutputRetention`，公开 JSON 值为 `complete` 与 `bounded_tail`。默认完整保留，省略默认值时保持旧清单字节兼容；未知枚举值拒绝。显式尾部保留仅撤销累计输出额度，宿主仍使用最多16MiB、65536块的有限缓存并保留真实序号，过期游标返回 Conflict。单块、有限通道、原业务期限、取消及清理确认继续生效；该策略不表示无限资源。

会话贡献复用 `Contribution` 的 `name`、`title`、`input_schema` 与可选 `execution`。对象输入模式只验证打开参数；之后的 input.bytes 为原字节块，遵守第五版单块与累计限额。预算仅复用原有纯数据，不使会话输入进入普通任务路径。

`SessionAccess::validate()` 校验版本、非空贡献、局部名称、重复名称、对象输入模式和声明预算，覆盖直接构造的 Rust 值。反序列化额外拒绝未知声明字段和错误版本。宿主仍须验证完整命名空间、完整 JSON 模式及清单组合；SDK 不编译模式或访问文件。

宿主组合规则：顶层普通 operations 允许为空的前提是 sessions 存在且贡献非空；会话与普通贡献不得重名，设备及性能来源仍只能引用普通贡献。独立会话由部署入口显式承载，不推断伪终端、远端连接或多会话复用能力。

便携包映射必须原样保留 sessions，不能在在线安装时丢失声明。产物能力继续由宿主准备输入副本并验证、发布输出；清单不是资源清理确认。

独立兼容与纯规则测试位于 `../tests/session_access.rs`。本模块交接时只新增声明、测试和说明，实际执行门禁由集成角色统一安排。
