# AAB 构建接口

## 操作与分层
android.package.build_apks 是普通后台任务，HTTP 与 MCP 共用操作注册、排队、取消和结果查询。领域 bundles 定义 BuildApksRequest / BuiltApks / BundleBuilder，应用层生成输入模式并调用端口，基础设施调用部署者配置的 bundletool。

请求示例：
```json
{"artifact_id":"00000000-0000-4000-8000-000000000001","mode":"universal"}
```
artifact_id 为已上传 AAB 的规范 UUID，mode 必填，只接受 default / universal；未知字段拒绝。请求不能指定密钥、口令、程序、输出路径或任意工具参数。

- default：构建面向全部受支持设备配置的 APK 集合；具体分包由 bundletool 决定。
- universal：构建含唯一 universal.apk 的 APKS；只融合声明 dist:fusing include=true 的功能模块，不能视为所有动态模块的完整离线包。

结果 BuiltApks 返回 source_artifact_id、mode、新产物 artifact、apk_count 和可选 universal_entry。通用模式可继续调用 android.package.extract_apk，再使用已有单 APK 安装操作。default 产物不能随意选择一个配置 APK 当作完整应用；现已通过 android.package.extract_splits 按四个常见设备维度提取组合，并通过 android.app.install_apks 匹配真实连接设备安装，详见 APKS设备匹配接口.md；高级匹配维度和真机验收继续推进。

## 部署配置
APK_JAVA 与 APK_BUNDLETOOL_JAR 指定受信任工具。构建另需同时配置：

| 环境变量 | 含义 |
| --- | --- |
| APK_BUNDLE_KEYSTORE | 已存在的签名密钥库绝对路径 |
| APK_BUNDLE_KEY_ALIAS | 签名别名，1–100 字节且不含控制字符 |
| APK_BUNDLE_STORE_PASSWORD_FILE | 已存在的密钥库密码文件绝对路径 |
| APK_BUNDLE_KEY_PASSWORD_FILE | 已存在的签名密钥密码文件绝对路径 |

四项均不配置时服务可启动，构建任务明确失败；部分配置、无效别名或不存在的文件拒绝启动。即使两个密码相同，也需显式提供两个文件配置，可指向同一文件。密码文件采用 bundletool 的 file: 参数，宿主不读取文件内容，文件权限由部署者管理。没有自动调试签名回退；用哪一个证书由部署者决定，重装同包名时仍需证书兼容。

工具环境只保留程序查找与系统所需变量，不继承 APK_API_TOKEN 等宿主凭据；独占临时目录作为工作目录和临时目录。stdout / stderr 各限 1 MiB，不返回工具原始诊断，依赖失败只返回固定说明，避免签名信息进入任务与事件。部署者应在受控环境独立诊断工具；此接口不提供原始诊断下载。

## 资源与产物边界
整个复制、构建、验证和发布阶段共用 120 秒期限，取消与 Future 丢弃会终止直接子进程；工具固定 max-threads=2，JVM 使用现有 ToolCommand 的堆上限。输入最多 64 MiB，下载复制验证大小与 SHA-256；正在生成的输出每 100 毫秒检查类型和 64 MiB 上限，工具退出后再次验证。

输出必须为普通文件，ZIP 路径不越界、不含符号链接、不重名；完整读取每个条目验证实际长度与 CRC，总展开体积最多 256 MiB。必须含非空 toc.pb 和至少一个带 ZIP 标识的 APK，universal 模式只接受唯一 universal.apk；结果验证后发布为新 APKS 产物。

toc.pb 当前仅检查存在与非空，不解析设备匹配元数据；APK 标识检查不等于 Android 内容或签名密码学验证，签名由可信 bundletool 执行。APKS 内部 APK 可通过已有签名操作进一步验收。输出轮询是软限制，工具可能在检查周期内短暂超额；工作目录其他文件没有硬磁盘配额。Windows 完整派生进程树回收仍待实现，管理员工具必须自行退出并清理子进程。

## 验证与后续
cargo test -p apk-infrastructure bundles 与 cargo test -p apk-application --test bundles 覆盖两个模式、提取后下载、路径与签名文件参数、错误诊断去敏、缺失配置、无效输出、CRC、体积、运行中取消、Future 丢弃、总期限和临时目录清理。

scripts/runtime-smoke.mjs 在真实服务器上通过 HTTP 构建 default，通过 MCP 构建 universal，验证下载摘要，再提取并走单 APK 安装任务。工具为独立模拟进程，签名文件为测试占位文件；这不构成真实 AAB / bundletool / 签名证书 / 真机验收。设备规格提取与 APKS 安装接口见 APKS设备匹配接口.md；高级匹配维度与真实包验收继续推进。

参数依据：Android 官方 bundletool 文档（核对日期 2026-10-08）：https://developer.android.com/tools/bundletool 。