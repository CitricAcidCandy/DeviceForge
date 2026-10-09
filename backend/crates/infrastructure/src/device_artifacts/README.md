# 设备产物操作

## 作用与适用场景
DeviceArtifactActions 将受控产物端口与管理员配置的 ADB / HDC 结合，实现安装、卸载及 Android 截图。独立于设备枚举适配器，不向请求方开放服务器文件路径或工具入口。

## 快速开始
在后端目录执行 `cargo test -p apk-infrastructure device_artifacts`。部署时配置 APK_ADB / APK_HDC，在 HTTP 上传安装包后，把返回的产物 ID 传给安装任务。公开操作自动进入 HTTP 操作列表与 MCP 工具列表。

## API 与参数
| 操作 | 必填参数 | 返回值 |
| --- | --- | --- |
| android.app.install | device_id、artifact_id | artifact_id、output |
| android.app.uninstall | device_id、package | output |
| android.screenshot | device_id | PNG 产物元数据 |
| harmony.app.install | device_id、artifact_id | artifact_id、output |
| harmony.app.uninstall | device_id、package | output |

Android 安装只接受 APK，Harmony 安装只接受 HAP。安装前流式复制并校验大小与 SHA-256，受控临时文件最多 64 MiB。单次复制与工具执行分别最多 120 秒。默认安装参数不申请降级、测试包许可或运行时权限；升级策略留待专门契约实现。卸载不保留应用数据。

安装、卸载同时检查标准输出和标准错误，失败文本优先；Android 要求独立的 Success 行，HDC 要求对应 install / uninstall bundle successfully. 文本。安装输出中的临时包路径替换为产物显示名称。

截图执行 ADB exec-out screencap -p，二进制标准输出分块写入临时文件，最多 64 MiB，工具期限 30 秒；成功后通过产物端口发布 PNG，产物写入期限 120 秒。PNG 检查范围沿用产物服务的头部检查，尚未进行完整图像解码。

## 取消与清理
进程超时或主动取消时杀死工具并等待退出。任务层直接丢弃执行 Future 时，kill_on_drop 停止工具；临时目录先尝试删除，Windows 文件句柄占用时后台最多重试 10 秒。重试只触及本次创建的独占目录。服务器进程异常退出后操作系统临时目录可能残留，当前不做全局临时目录扫描。

## 验证
使用 rustc 编译独立模拟工具，验证真实 argv、APK / HAP 安装、卸载参数、退出码、标准错误失败、缺失成功文本、SHA-256 篡改、截图字节、输出上限、超时、运行中取消及丢弃 Future 后清理。测试需要 Rust 编译器，不需要连接真机；Android / Harmony 真机验收仍待执行。
