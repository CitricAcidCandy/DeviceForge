# 受限数据编解码公共库

独立处理 JSON、标准 MessagePack 与 JPEG 结构资格，不引用宿主领域、应用、HTTP 或文件系统。上传校验和插件转换共同使用本库，避免资源边界出现两套规则。

公开函数：parse_json 校验并解析 JSON；validate_msgpack 预扫描标准二进制结构；encode_json 转 MessagePack；decode_json 转普通 JSON 值；json_bytes 以受限写入器生成 JSON 文件。

输入及文件输出最多 16 MiB，根值深度为 0，子值深度最多 64，节点最多 100000，映射键和值分别计数。先检查声明长度、完整负载和节点数量，再允许 MessagePack 库分配容器。只接受单一根值，拒绝截断、保留标记及尾随数据。

JSON 拒绝重复键、非 UTF-8、超出 i64/u64 范围的整数与非有限浮点数。普通 JSON 转换支持空值、布尔、64 位整数、有限浮点、UTF-8 字符串、数组及唯一字符串键映射。MessagePack 的 binary、ext、非字符串键、重复键、无效 UTF-8 和非有限浮点是可存储的标准结构，但不能保真转换为普通 JSON，转换时明确拒绝。浮点按 IEEE 754 表示，不提供任意精度十进制。

`cargo test -p deviceforge-data-codec` 覆盖整数极值、中文、重复键、类型拒绝、截断/尾随、恶意长度、深度/节点/体积和输出转义膨胀。标准结构不证明旧 DLL 私有容器兼容；JavaScript 客户端读取超过 2^53−1 的整数可能丢失精度，须使用能保留整数文本的解析器。

JPEG 使用独立的 `jpeg::Validator` 增量入口及 `jpeg::Error`，不复用上述 JSON/MessagePack 的 16 MiB 限额和错误类型。输入上限 64 MiB、65,536 个非 SOI 标记，固定状态支持 SOF0/SOF2 的最低结构检查；不执行熵解码或视觉验证。职责、支持范围与测试见 [JPEG 模块](src/jpeg/README.md)。
