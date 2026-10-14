# MessagePack 插件接口

## 部署与职责
这是公开协议 2 的独立进程插件，使用共享受限编解码库。管理员部署清单见 plugins/msgpack；HTTP 与 MCP 自动发现三项操作，复用既有任务及产物服务，不另加业务路由。请求只传产物 ID，不传服务器文件、程序或输出目录。

| 操作 | 输入 | 结果 |
| --- | --- | --- |
| plugin.msgpack.encode | JSON 产物 artifact_id | converted.msgpack 新产物 |
| plugin.msgpack.decode | MessagePack 产物 artifact_id | converted.json 新产物 |
| plugin.msgpack.query | MessagePack 数组产物、offset、limit、可选 filter | 分页记录，无文件 |

转换的 result 包含 format_version=1、source_artifact_id、filename、size。宿主统一包装 `{result,artifacts}`，下载使用 HTTP 产物接口；MCP 调用先获得任务 ID，再查询终态。接口贡献由部署清单描述，通用 PluginArtifactResult 使用 Rust 生成类型。

## 查询契约
offset 默认 0、最多 100000，limit 默认 50、范围 1–100。filter 为 `{field,operator,value}`，field 为 1–100 字节单层字段名，无控制字符；不解释点号为嵌套路径。先筛选后跳过 offset，保持源顺序。total 为源记录数，matched 为全部匹配数，next_offset 无后页时为 null；offset 等于 matched 返回空页，超过则失败。

equals 支持 JSON 值，数值按大小比较；contains 仅接受字符串且区分大小写；greater/less 仅接受数字。缺失字段不匹配，显式 null 可以 equals 匹配。按 ID 读取使用 filter.field=id、operator=equals 和 limit=1。并不要求记录 ID 唯一，也不创建文件数据库或常驻 DLL 句柄。

```json
{"artifact_id":"规范 UUID","offset":0,"limit":1,"filter":{"field":"id","operator":"equals","value":123}}
```

query.result 返回 format_version、source_artifact_id、total、matched、offset、records、next_offset；宿主 artifacts 为空数组。结果序列化最多 128 KiB。查询每次完整解析受限输入，没有流式读取或索引保证。

## 表示与资源边界
JSON/MessagePack 文件输入及转换输出最多 16 MiB，节点最多 100000、深度最多 64；映射键和值都计节点，根深度为 0。上传和插件输出共同执行库校验，流式上传在类型体积超限时提前返回 413。结构非法返回 400，插件执行失败体现为任务 failed。

普通 JSON 转换支持 nil、布尔、i64/u64、有限浮点、UTF-8 字符串、数组及唯一字符串键映射。binary、ext（含时间戳扩展）、无效 UTF-8、非字符串/重复键和非有限浮点不能保真转换，明确拒绝。标准 MessagePack 上传只验证结构，允许这些标准类型存储，不代表可转换。JSON 拒绝重复对象键和越界整数，不静默转为有损浮点。

i64/u64 文件转换保留整数，查询整数比较使用更宽整数；混合浮点比较中绝对值大于 2^53 的整数失败。JavaScript JSON.parse 仍可能损失超过 2^53−1 的整数精度，客户端需采用保留大整数的解析方案。有限浮点按 IEEE 754 处理，不承诺任意精度十进制或原 JSON 文本、字段顺序与 MessagePack 原字节编码保持不变。

## 旧模块兼容与验收
旧 msgpack.ts 通过原生 DLL 提供全量、批次、offset/limit、单字段筛选、按 ID 读取及句柄生命周期。当前转换覆盖标准格式，query 覆盖分页/筛选/按 ID 行为；全量大结果应使用 decode 文件下载，旧原生句柄机制不复制。

旧 Tools/msgpack/libmsgpcak_dll.dll 的私有容器没有格式源码及有效样本证据，不能宣称完整迁移或格式兼容。后续需要真实样本与旧 DLL 对照，若含私有封装应单独实现版本化适配器。

测试覆盖库边界、查询规则、真实插件进程和受控产物。runtime-smoke 使用真实 HTTP/MCP 服务与构建后的插件验证上传、编码、解码、分页/按 ID、下载摘要及非法类型/数据/大小拒绝；设备工具仍为模拟工具。私有格式、真实业务样本和负载性能尚未验收。
