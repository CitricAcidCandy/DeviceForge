# APK 反编译和 SDK 路径适配器

## 作用与快速开始
AndroidReverse 实现 PackageReverse，反编译 APK 后发布 ZIP，再按规则检查 smali 包路径和类检测点。执行 `cargo test -p apk-infrastructure reverse` 验证基础设施行为。

服务器通过 APK_APKTOOL_JAR 配置管理员提供的 Apktool JAR，APK_JAVA 指定 Java 入口。沿用 ToolCommand 的固定 `-Xmx256m -jar` 前缀；未配置 JAR 时反编译任务明确失败，已有 ZIP 的 SDK 检测仍可用。

## API 与参数
- decode(artifact_id, cancel)：仅接受 APK，先流式校验大小及 SHA-256，执行 `decode 输入 --output 独占目录 --frame-path 独占缓存`，打包并发布 decoded.zip。
- scan_sdks(artifact_id, rules, cancel)：仅接受 ZIP，要求非空 apktool.yml 和 AndroidManifest.xml，检查 smali / smali_classesN（N >= 2）下的路径。
- rules：1 到 100 条，名称非空、最多 100 字节且唯一；包路径最多 200 字节，按点分隔标识符；可选类名最多 100 字节，支持 Entry$Inner 形式，不接受文件后缀或路径。

包目录匹配使用完整路径段边界，com.example.sdk 不匹配 com.example.sdk2。检测点为指定包下精确 class_name.smali。每条最多十条排序后的路径证据，检测点通过时保证其出现在证据中。这里只检查 ZIP 目录，不解压 smali 内容或校验其 CRC，不推断 SDK 版本或运行时状态。

## 资源与清理
每个任务独占输出和 framework 缓存，取消后回收临时目录；不使用共享反编译目录、全局 isRunning 或用户服务器路径。

输入单文件最大 64 MiB，准备、工具、打包和发布各阶段最多 120 秒。工具标准输出与错误各最多 1 MiB。输出目录限制 10000 个文件 / 目录条目、128 层以及普通文件总量 64 MiB；工具运行时每次检查完成后间隔 500 毫秒再次检查，超限时取消工具并等待退出。该监测是定期检查，不是操作系统磁盘硬配额，工具快速写入可能短暂超限；framework 缓存不计入输出统计。部署级磁盘配额尚待配置服务实现。

工具成功退出后再检查 apktool.yml / AndroidManifest.xml，并流式打包 Stored ZIP，整个 ZIP 写入最多 64 MiB，拒绝链接、重解析路径和非普通文件。打包线程持有目录守卫并逐块观察取消。输出若含过多资源或 smali，会明确失败，不截断代码或静默省略文件。ZIP 发布后可通过既有 HTTP 下载或条目预览接口读取。

## 验证与限制
真实模拟 Apktool 子进程验证参数、独立目录、退出失败、无输出、运行中取消及输出过量；测试覆盖多 DEX 路径、内部类、包前缀边界、缺失检测点、伪 smali 根目录、证据上限和规则错误。Unix 专有链接拒绝测试在 Windows 不运行。

本地 Apktool 2.9.0 帮助输出确认参数；真实 APK 反编译和 SDK 验收仍待执行。没有内置固定 SDK 知识库、版本识别、DEX 二进制扫描、混淆恢复或 Java 源码反编译。此接口提供资源解码与 smali 反汇编，使用规则做路径检测。
