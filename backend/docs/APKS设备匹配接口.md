# APKS 设备匹配与分包接口

## 共享任务操作
领域 splits 定义 SplitPackages 端口与类型化请求 / 结果；application 注册两项操作，HTTP / MCP 共用任务层。工具入口由服务部署者配置，不新增业务专用路由。

| 操作 | 输入 | 结果 |
| --- | --- | --- |
| android.package.extract_splits | APKS 产物 ID、设备规格 | 普通 ZIP 产物、排序后的 APK 条目、原产物与规格 |
| android.app.install_apks | APKS 产物 ID、设备编号 | artifact_id、device_id、installed |

提取示例：
```json
{
  "artifact_id": "00000000-0000-4000-8000-000000000001",
  "device_spec": {
    "supported_abis": ["arm64-v8a", "armeabi-v7a"],
    "supported_locales": ["zh_CN", "en-US"],
    "screen_density": 480,
    "sdk_version": 35
  }
}
```
规范 UUID 与未知字段由生成模式及执行层校验。ABI 列表 1–16 项，语言列表 1–100 项，列表元素不重复；每个元素 1–80 字节，只含 ASCII 字母 / 数字 / 下划线 / 连字符。密度与 SDK 为 1–10000 的整数。ABI 顺序保留，由 bundletool 按实际兼容规则选择；列表元素校验不是完整的 ABI 或语言标签标准解析。

设备规格由请求提供，宿主写入独占临时 JSON，字段映射为 bundletool 的 supportedAbis / supportedLocales / screenDensity / sdkVersion；请求不能传服务器 JSON 路径。匹配和 toc.pb 语义解析交给受信任 bundletool，不按 APK 文件名猜测组合。当前只提供这四个常见维度；设备特性、设备档位、纹理压缩、模块选择、instant 与设备规格自动读取尚未提供，涉及这些条件的包仍需后续适配与真机验收。

## 提取产物
extract-apks 固定输出到独占 selected 目录。工具退出后检查只含普通 APK 文件，不含符号链接或重解析路径；保留相对名称，以字典序写入 selected-apks.zip，返回 apk_entries。提取 ZIP 没有 toc.pb，不能当作 APKS 再调用 install_apks；要部署应用应把原 APKS 交给安装操作，让工具按实时设备配置选择组合。

APKS 输入复制验证大小与 SHA-256，完整读取外层条目检查 CRC、路径、重名、256 MiB 总展开限制，以及非空 toc.pb / APK 布局；toc.pb 由工具进一步校验。输出目录最多 1000 个条目（含目录）、深度最多 128、文件总量最多 64 MiB；每个 APK 检查 ZIP 目录结构、路径与声明展开体积，未独立验证内部全部 CRC 或 Android 签名。最终 ZIP 流式打包并限制总输出 64 MiB；验证与打包失败不发布结果产物。

工具运行时每 100 毫秒检查输出树体积与路径，允许尚未写完的 APK，到最终打包前再检查容器。轮询是软限制，工具可能短暂超额；整个工作目录仍无硬磁盘配额，无法约束恶意管理员工具。

## APKS 安装
安装示例：
```json
{"artifact_id":"00000000-0000-4000-8000-000000000001","device_id":"192.168.1.2:5555"}
```
设备编号使用既有标识规则，不接受空值、选项前缀或 shell 字符。install-apks 固定传 --apks、--device-id 与 --adb，默认安装首次安装所需的模块；不开放降级、test-only、模块清单等额外工具参数。安装没有签名密钥配置要求，使用 APKS 内已有 APK 签名。

APK_ADB 由部署者提供，可为实际路径或 PATH 中的工具名称。宿主在改变工作目录前解析并规范化为现有文件，再显式传给 bundletool。APK_BUNDLETOOL_JAR 应配置为绝对路径，APK_JAVA 为可启动的受信任 Java 工具。未配置 bundletool、缺失 ADB、设备不兼容或离线时任务失败。

同一个 AndroidSplits 实例内的 APKS 安装按设备串行，不同设备可以并行。锁使用弱引用并清理无活跃引用的设备编号，避免常驻表增长；该锁当前不覆盖其他单 APK 安装 / 输入 / 卸载操作，不宣称所有设备写操作全局互斥。

bundletool 安装可在退出码为零时不打印明确成功行，因此 accepted 条件为正常退出且合并 stdout / stderr 不含 failure / failed / error / unable / cannot / offline / unauthorized / no devices / incompatible 失败诊断；不要求 ADB 的 Success 文本。installed=true 表示工具安装调用完成，不证明应用启动、包内容真实性或业务行为正确。没有独立包管理器复核；工具版本及真机验收仍需确认。

## 生命周期与可信边界
每次提取 / 安装的复制、校验、等待设备锁、工具执行、打包及发布共用 120 秒总期限。直接子进程支持取消与 Future 丢弃清理；阻塞校验 / 打包通过取消令牌退出并保留临时目录守卫。工具环境剥离宿主凭据，stdout / stderr 各限制 1 MiB，不向任务持久化原始工具诊断或服务器临时路径。

取消或超时不意味着设备安装事务回滚；安装可能已提交，调用方需检查设备实际状态再决定重试。完整派生进程树回收、工作目录硬配额与全局设备操作互斥尚未实现。

## 验证证据
- cargo test -p apk-infrastructure splits：8 项测试覆盖不同规格的选包、ZIP 下载、APKS 安装、离线及零退出码失败诊断、输入 / 配置 / 包体检查、输出错误与体积、同设备等待 / 不同设备并行、取消、Future 丢弃、总期限和临时清理。
- cargo test -p apk-application --test splits：生成模式与执行验证边界一致，拒绝重复规格元素、越界数值、未知字段、请求选择 ADB 与无效设备编号。
- scripts/runtime-smoke.mjs：真实 HTTP 规格提取与产物目录 / 摘要下载、MCP APKS 安装、HTTP 离线失败和非法工具字段拒绝；同时保留已有构建、性能及其他业务验证。
- 本地 Tools/bundletool-all-1.3.0/bundletool-all-1.3.0.jar 的 help install-apks / help extract-apks 已实际运行，确认参数兼容；这是帮助命令证据，不等于真实包匹配或安装验收。

工具进程与 APK / toc 测试数据为模拟，不构成真实 APKS / 真机证据。真实包、设备权限、版本差异、提交后取消及运行状态仍待验收。

参数参考：Android 官方 bundletool 文档及 Google bundletool InstallApksCommand / ExtractApksCommand 源码，核对日期 2026-10-08。