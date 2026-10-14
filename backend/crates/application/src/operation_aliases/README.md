# 操作绑定纯模块

本模块实现 [操作绑定第一批契约](../../../../docs/contracts/操作绑定第一批契约.md) 的部署类型、纯规则及输入/结果投影。采用已批准的 architecture-first / Hybrid，先写行为测试，再接入实现；不读配置文件、不访问注册锁或产物存储，不提交 Job，也不执行平台工具。

| 文件 | 职责 |
| --- | --- |
| mod.rs | 公开类型和纯函数导出 |
| config.rs | 严格 serde 配置、默认格式 1 空绑定、目标插件 ID 查询 |
| rules.rs | 数量、ID、局部 schema、字段、文件名及 JSON Pointer 校验 |
| mapping.rs | 输入封套、严格宿主包装、有限字段和产物投影 |
| tests.rs | 配置边界、真实业务形状、包装/投影成功与失败回归 |

公开入口为 `Config::validate`、`Binding::plugin_id`、`map_input` 和 `map_result`。Config、Binding、字段、各内部 tag 枚举都拒绝未知属性；嵌套 Operation 通过本模块专用反序列化同样拒绝未知属性，不更改领域 Operation 的其他使用者。

`ResultMapping::requires_host_result` 是注册准入可调用的纯方法：Value/Object 的 wrapped=true、Artifact、Object 中任意 artifact 源返回 true，optional 产物字段也不例外；Identity 和不包装、不选择产物的投影返回 false。这个声明属性不等于宿主发布证据，不能仅凭包装 JSON 或插件自填 Artifact 证明来源；真实结果格式端口、ProcessPlugin 声明及 registry 门禁由主代理接入。

ResultMapping 的 identity 使用空结构变体 `Identity {}`，使内部 tag 下的 deny_unknown_fields 生效；JSON 仍是 `{"kind":"identity"}`，不会增加字段。普通单位变体会忽略多余属性，不能用于此严格对象边界。Target 和 FieldSource 的内部 tag 变体都有明确字段；InputMapping 仍是原字符串单位枚举。

配置格式固定 1，最多 256 个绑定；别名不能占 plugin. 或 deviceforge. 命名空间，重复别名为 Invalid。操作 ID 最多 128 字节并沿现 MCP 字符规则；plugin_id 沿领域规则最多 99 字节；能力 ID 沿领域规则最多 100 字节、版本非零；普通目标操作必须带完整 plugin.<id>. 前缀及非空后缀。目标存在、发现/设备贡献是否能作普通目标、精确能力版本匹配以及仅当前插件的加载校验，由注册集成层负责。

本批配置验证明确拒绝 android.devices 和 harmony.devices 别名，不论目标是普通操作还是设备能力；不能用 echo 等普通结果占用旧发现入口。原始状态保真和统一发现发布仍待后续契约。

输入模式要求对象，并调用现有 validate_local_schema 拒绝外部引用和 $id；本模块不以假业务输入验证 schema，也不编译旧/目标双 schema。配置文件 64 KiB 限额、受限工作池和实际提交 schema 验证由装配/应用集成负责。

device_envelope 只用于 DeviceCapability 配置。设备范围必须有合法字符串 device_id；提供者范围只接受缺失或显式 null，非 null 一律 Invalid。删除旧顶层 device_id 后，其余属性原样进入 input，不推断平台或写标志。identity 原样克隆，包括调用者交来的封套，由集成层验证实际目标 schema。

结果 identity 和 value 的 wrapped=false 完全原样返回；wrapped=true 仅接受恰好 result/artifacts 两字段的宿主包装，artifacts 必须能完整解析为领域 Artifact 列表。object 的 wrapped 只决定 value 源是否解包；只要使用 artifact 源，仍需原始执行输出是宿主包装，即使 wrapped=false。产物只从本次宿主列表按精确 filename 唯一匹配，不读业务 result 的 ID、不默认取第一项；纯模块无法查询存储证明来源，调用者必须传入真实执行/发布结果。

object 最多 32 字段，name 唯一、非空、无控制符且最多 128 UTF-8 字节。JSON Pointer 最多 128 字节，空字符串选择根；支持 ~0/~1、Unicode 对象键及规范十进制数组索引，没有表达式或通配符。对象中的数字是原键；数组越界或超过 usize 的规范索引视为缺失；错误索引、非法转义、穿过非容器值均失败。filename 最多 180 字节，沿既有不含路径/控制符、不以点起始或点/空格结束的命名边界，不在此推断文件类型。

optional 缺省 false；true 只省略缺失 pointer 或指定 filename 零匹配，显式 null 保留。必填源缺失、重复匹配、坏 wrapper、坏路径结构始终 Dependency，不能被 optional 吞掉。所有执行结果映射错误使用 Dependency；配置及封套输入错误使用 Invalid，错误文案不包含原始输入/结果。

主代理负责 lib 导出、注册原子发布/撤销、双 schema 编译、同 Job 快照准入、生命周期、设备锁和绝对期限；本模块不将这些行为写成已完成。旧发现、raw_state 加法、非设备长任务和性能生命周期仍属后续批次。

当前交接仅包含源码和意义单测，未运行 Cargo、fmt、构建或服务；由主代理串行接入并执行门禁。建议定向入口为 `cargo test -p apk-application operation_aliases`，其通过后仍需同任务/注册/卸载集成和受影响真实运行验证。

BIND-001 修复前，主代理定向测试实际为 19 通过、1 失败：identity 忽略多余 wrapped 属性。现保留原失败断言并新增 identity 序列化、反序列化和嵌套配置拒绝回归；修复后的编译、fmt 和测试尚未执行，由主代理统一验收，不把原结果记为通过。
