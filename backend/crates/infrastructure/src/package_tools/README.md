# Android 安装包工具适配器

## 作用与快速开始
实现领域 PackageAnalyzer，通过受控 APK / AAB / APKS 产物提供清单、签名和选定 APK 提取。执行 `cargo test -p apk-infrastructure package_tools` 可运行解析与真实模拟子进程测试。

## API 与部署参数
AndroidPackageTools 注入 ArtifactStore、apkanalyzer、apksigner 和可选 bundletool。ToolCommand 接受部署者固定入口与固定前缀参数；java_jar 使用 `-Xmx256m -jar` 限定 Java 堆。服务启动配置：

| 环境变量 | 用途 |
| --- | --- |
| APK_APKANALYZER | APK 解码工具入口，默认 apkanalyzer |
| APK_APKSIGNER | 签名工具入口，默认 apksigner |
| APK_APKSIGNER_JAR | 可选签名 JAR，配置后优先于入口变量 |
| APK_JAVA | Java 入口，默认 java |
| APK_BUNDLETOOL_JAR | AAB 分析 JAR；未配置时 AAB 任务明确失败 |

工具执行不通过 shell。Windows 需要配置可直接执行的工具入口；没有直接执行入口时使用 JAR 配置，当前没有自动执行 .bat / .cmd 包装脚本。

## 工具命令与结果
APK：apkanalyzer manifest print；AAB：bundletool dump manifest --bundle=受控路径 --module=模块名。输出由 quick-xml 解析，按 Android 命名空间提取版本、SDK、应用名称、debuggable 与权限，保留完整 XML。最大 1 MiB、20000 个节点、128 层深度；拒绝 DTD、未定义实体、命名空间歧义、重复根及重复主要字段。标签资源引用不自动解析。

APK 签名：apksigner verify --verbose --print-certs。要求退出成功、明确 Verifies、至少一个签名方案通过、完整连续编号的签名者及 64 位十六进制证书 SHA-256。验证失败收敛为任务失败；警告保留在 report，当前不启用 -Werr。此接口不验证 AAB JAR 签名或每个 APKS 分包签名。

APKS：用户精确选中一个 APK 条目，解压至独占临时文件，最多 64 MiB，完整读取并检查所选条目 CRC，再经产物服务验证容器后发布 extracted.apk。阻塞解压线程持有目录守卫并逐块检查取消。不会将压缩条目名映射为服务器目录；拒绝同名条目和穿越路径。

准备阶段复用 artifact_files 的流式大小与 SHA-256 校验；复制、工具、解压和发布各阶段期限最多 120 秒。标准输出与标准错误各最多 1 MiB。分析返回的清单和签名结构由领域类型生成 OpenAPI，具体操作输入从公开注册器发现。

## 验证范围与缺口
独立模拟子进程验证实际参数、固定前缀、退出失败、空输出、无效结果、运行中取消、未配置工具、产物篡改；解压验证字节一致、CRC、条目不存在、路径、重复名称和无效嵌套容器。真实服务脚本覆盖 HTTP / MCP 分析、签名和 APKS 提取后安装。

现有 apksigner.jar 与 bundletool 1.3.0 的帮助输出已确认命令参数；尚无真实安装包分析验收。APK 反编译与 smali SDK 路径检测由 reverse 模块提供；本模块不实施 DEX 直接扫描、图标解析、AAB 转换、设备匹配分包选择或多 APK 安装；精确提取单个分包不代表该分包可以独立安装。
