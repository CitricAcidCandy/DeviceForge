# 标准 MessagePack 进程插件

生产依赖仅公开 apk-plugin-sdk、deviceforge-data-codec 与序列化库。文件读写只使用宿主协议 2 提供的输入副本和独占输出目录，不加载旧 DLL，不接受请求中的服务器路径。

根目录执行 `npm run pack:plugins -- msgpack` 生成当前平台 release 便携 tgz，使用 npx 的 plugin install 安装后重启服务；包描述从 Cargo 和现有清单派生，见 ../../docs/原生插件分发.md。源码目录本身不是便携安装包。

手工源码部署仍可执行 `cargo build -p deviceforge-msgpack-plugin`，复制 manifest.example.json 到管理员插件子目录并改为实际绝对入口；配置 APK_PLUGIN_DIR 并重启服务。

贡献 `plugin.msgpack.encode`、decode、query。encode 接收 .json 的 artifact_id，输出 converted.msgpack；decode 接收 .msgpack 的 artifact_id，输出 converted.json。任务成功结果由宿主包装为 result + artifacts，后续操作使用新产物 ID。query 要求根值是数组，先筛选后分页，默认 offset=0、limit=50，页大小 1–100、偏移最多 100000；返回 total、matched、records、next_offset，无输出文件。筛选为单层字段的 equals/contains/greater/less；按 ID 读取可用 equals + limit=1。

`src/main.rs` 负责协议关联、授权副本、受限读取及固定输出；`src/query.rs` 负责纯查询规则。数据限制为 16 MiB、64 层、100000 节点，查询结果最多 128 KiB，超限应减页或使用文件转换。contains 只比较字符串，数值比较精确保留 i64/u64，混合浮点时拒绝超出 2^53 的整数。

`cargo test -p deviceforge-msgpack-plugin` 验证分页规则与真实进程，包含双向转换、最大整数、按 ID 读取、类型错误、未知字段、输出授权、输入篡改及不覆盖已有文件。标准 MessagePack 与普通 JSON 的表示边界见 ../../docs/MessagePack插件接口.md；旧 libmsgpcak_dll.dll 私有格式尚未证明兼容，迁移未全部完成。
