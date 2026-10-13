# 设备时钟助手构建

本目录的 Java 入口为 com.deviceforge.profile.ClockAnchor，只读设备的 System.nanoTime 与 SystemClock.elapsedRealtimeNanos，并输出 DFPC1 校时观测。构建脚本不修改 Java 源码、不连接设备，也不取得 Root 权限。

## 环境与参数

需要 Node.js 22 以上、完整 JDK（建议 17 或以上）及 Android SDK。SDK 需安装一个 API 不低于 21 的平台和带 lib/d8.jar 的 build-tools；只有 JRE 不足以运行 javac 和 jar。

| 参数 | 含义与默认值 |
| --- | --- |
| --sdk | Android SDK 根目录；缺省读取 ANDROID_SDK_ROOT |
| --jdk | JDK 根目录；缺省读取 JAVA_HOME |
| --platform | 已安装平台，可填 android-35 或 35；缺省选择已安装最高数字 API，要求至少 21 |
| --build-tools | 精确的稳定数字版本，例如 35.0.0；缺省选择已安装最高稳定数字版本 |
| --out | 输出目录；缺省为本脚本所在目录的 build 子目录 |
| --help | 显示帮助，不执行工具 |

在工程根目录的 PowerShell 中可执行：

~~~powershell
node .\backend\plugins\android-device\clock-helper\build.mjs --sdk "$env:ANDROID_SDK_ROOT" --jdk "$env:JAVA_HOME" --platform android-35 --build-tools 35.0.0 --out .\artifacts\profile-clock-helper
~~~

platform 和 build-tools 必须对应本机已安装版本。也可只设置两个环境变量后直接执行脚本，使用自动选择的 SDK 版本。路径含空格时由 shell 正常引用，脚本内部仍以独立 argv 调用工具，没有 shell 命令拼接或机器绝对路径硬编码。

## 产物与构建流程

输出为指定目录下的 profile-clock.jar，内容为 Android classes.dex，供插件通过部署配置的 clock_helper 路径使用，不是服务器 Java 程序。流程为：

1. 用所选 JDK 的 javac 编译 Java 源码，UTF-8、Java 8 字节码，使用所选平台 android.jar。
2. 用所选 JDK 的 java 调用 Android build-tools/lib/d8.jar 中的 com.android.tools.r8.D8，固定 --release 和 --min-api 21。
3. 用同一 JDK 的 jar 打包 classes.dex，成功后原子替换指定输出目录的 profile-clock.jar。

脚本只覆盖固定命名的普通产物文件；目标若是目录或符号链接会失败。不删除调用者输出目录及其他文件。编译失败或取消不会发布半成品；成功产物仍需由部署者配置到服务器，脚本不自动上传或启动设备进程。

## 资源与失败

每条工具命令最多 120 秒，构建阶段总截止点为 300 秒；stdout/stderr 合计最多 1 MiB。超量、超时、SIGINT/SIGTERM 取消或非零工具退出均返回退出码 1。脚本会终止本次拥有的直接工具并等待退出，不启动后台服务。

Java 源码最多 16 文件、合计 1 MiB，class 文件最多 64 个、合计 1 MiB，classes.dex 最大 1 MiB，最终 JAR 最大 2 MiB。构建使用系统临时目录中独占的 deviceforge-clock-helper-* 目录；清理前检查实际绝对路径和父目录归属，只回收本次自建目录和本次发布暂存文件。

本批由主代理执行构建及产物验证。本脚本及说明的提交不代表助手已在真机或模拟器上运行；设备时钟误差、Android/OEM 兼容和 scrcpy PTS 映射仍需对应运行证据。
