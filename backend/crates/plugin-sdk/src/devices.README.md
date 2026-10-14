# 设备提供者公开契约

Manifest.devices 是可选贡献，旧清单不需要新增字段。当前设备声明 API 为 3，宿主继续支持 API 1/2；发现操作与能力操作均引用同一插件的相对贡献名，宿主负责命名空间映射、校验和能力路由。

API 2/3 每项能力可声明 execution_timeout_ms，省略或 null 为宿主默认 30000 毫秒，显式值为 1–120000 毫秒；API 1 不允许非空预算。此字段是部署声明，不是浏览器动作参数。新宿主兼容旧清单，不支持 API 3 的旧宿主会拒绝 API 3。排队、锁、输入副本、执行和发布共享同一准入截止点，清理预算独立；发现自身仍使用 30000 毫秒，不套能力预算，无设备上下文的通用插件仍沿用原阶段期限。

发现输入为空对象，输出 PluginDevice 数组；设备 ID 属于提供者本地命名空间，宿主再添加提供者和加载代际。平台字符串仅供展示，不能用于选择平台实现。能力区分 provider/device 范围与 read/write；标准动作输入是 device_id 和 input 对象。

PluginDevice 增加可选 raw_state，缺失或 null 反序列化为 None，None 序列化时省略。API 1/2 拒绝任何非 null 原文；API 3 接受缺失、null 或有效字符串。有效原文须非空、非全空白、最多 100 UTF-8 字节且不含 Unicode 控制字符；宿主保留原文，不 trim、转小写、截断或猜平台。SDK 消息本身不携带声明版本，版本和文字边界由宿主结合提供者声明统一校验，任一坏设备使整份发现失败。

state 的 online/offline/unauthorized/unknown 枚举保持原义；未知合法 raw_state 可保留，但 recovery/sideload/bootloader 等原文不放宽动作准入。设备声明 API、Manifest 顶层版本、任务协议 1/2/3、浏览器 SDK 2、HTTP v2 和操作绑定版本分别校验，不能互相推导。

本契约复用现有每任务独立进程与协议 1/2/3，不表示常驻连接、设备监测或流媒体已经实现。数量、声明引用、发现结果、取消与热装卸由宿主验证；完整实施边界见后端 docs/implementation/设备提供者第一阶段实施.md。

发现操作接收空对象；能力操作使用标准封套 `{device_id:null|string,input:object}`。业务 input 可以包含必填字段及其他 JSON Schema 约束，设备 ID 可限定 pattern/enum；注册不要求空业务参数或固定假设备 ID 合法，真正提交时验证实际输入。能力范围和读写属性由清单决定，业务输入不能覆盖。

协议 2/3 可通过 artifacts.input_pointers 声明设备封套内的 `/input/artifact_id`，宿主选择并准备独立输入副本，业务输入仍保留产物 ID。不得通过私有宿主源码或服务器任意路径绕过；输出产物沿用原有声明和有界发布。
