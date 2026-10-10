# 设备产物操作

## 作用与适用场景
DeviceArtifactActions 将受控产物端口与管理员配置的 ADB / HDC 结合，实现安装、卸载及 Android 截图。独立于设备枚举适配器，不向请求方开放服务器文件路径或工具入口。

首批Android七能力撤除接缝新增`RemainingDeviceArtifactActions::new(adb, hdc, artifacts)`：私有包住旧实现，仅声明与执行Android APK安装、截图及Harmony HAP安装/卸载四项。`execute`与`execute_with_context`在委托前固定白名单检查，Android卸载及未知操作为NotFound且不触工具或产物端口。旧DeviceArtifactActions仍保留五流兼容代码，main残余装配切换与服务验收由主代理完成。

## 快速开始
在后端目录执行 `cargo test -p apk-infrastructure device_artifacts`。部署时配置 APK_ADB / APK_HDC，在 HTTP 上传安装包后，把返回的产物 ID 传给安装任务。公开操作自动进入 HTTP 操作列表与 MCP 工具列表。

## 旧实现 API 与残余装配
| 操作 | 必填参数 | 返回值 |
| --- | --- | --- |
| android.app.install | device_id、artifact_id | artifact_id、output |
| android.app.uninstall | device_id、package | output |
| android.screenshot | device_id | PNG 产物元数据 |
| harmony.app.install | device_id、artifact_id | artifact_id、output |
| harmony.app.uninstall | device_id、package | output |

上表android.app.uninstall仅属于旧兼容实现，不进入残余侧车白名单；其新生产归属为android-device版本1设备能力。侧车保留原输入、输出、ArtifactStore和工具部署源，不复制四流业务。

Android 安装只接受 APK，Harmony 安装只接受 HAP。安装前流式复制并校验大小与 SHA-256，受控临时文件最多 64 MiB。单次复制与工具执行分别最多 120 秒。默认安装参数不申请降级、测试包许可或运行时权限；升级策略留待专门契约实现。卸载不保留应用数据。

安装、卸载同时检查标准输出和标准错误，失败文本优先；Android 要求独立的 Success 行，HDC 要求对应 install / uninstall bundle successfully. 文本。安装输出中的临时包路径替换为产物显示名称。

截图执行 ADB exec-out screencap -p，二进制标准输出分块写入临时文件，最多 64 MiB，工具期限 30 秒；成功后通过产物端口发布 PNG，产物写入期限 120 秒。PNG 检查范围沿用产物服务的头部检查，尚未进行完整图像解码。

## 取消与清理
工具取消及Future丢弃沿当前process与公共工具库清理；临时目录先尝试删除，Windows文件句柄占用时后台最多重试10秒，重试只触及本次创建的独占目录。Future结束不能独立证明实际工具/目录已排空。服务器进程异常退出后临时目录可能残留，当前不做全局临时目录扫描。

侧车原样转发ExecutionContext与has_unresolved_resources，不补齐底层原D或清理资格。旧实现当前仍沿默认context委托和默认未确认资源观测，安装复制/工具及截图工具/发布各自旧阶段上限保持；不能把新包装器当作端到端期限或持久清理标记已实现。保留流也没有自动并入新设备提供者的跨能力共享锁，这些接缝继续后续批次。

## 验证
使用 rustc 编译独立模拟工具，验证真实 argv、APK / HAP 安装、卸载参数、退出码、标准错误失败、缺失成功文本、SHA-256 篡改、截图字节、输出上限、超时、运行中取消及丢弃 Future 后清理。测试需要 Rust 编译器，不需要连接真机；Android / Harmony 真机验收仍待执行。

新增remaining/tests.rs直接调用残余侧车：证明四项白名单、两入口拒已迁出卸载且工具/产物零副作用，两执行入口实际保留APK/HAP安装、HDC卸载与原PNG字节，并保留stderr失败、坏PNG及取消边界。本角色只写测试，未执行格式化、编译、测试或服务；实际验证另记，不借旧完整执行器通过计新侧车完成。
