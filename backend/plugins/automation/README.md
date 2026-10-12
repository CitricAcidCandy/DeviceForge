# 自动化业务插件

当前真实实现设备动作序列和重复点击：`plugin.automation.sequence.run` 的 steps 使用绝对相对起点毫秒 at_ms，动作支持 tap/swipe/key/text；`click.repeat` 使用 count 与 interval_ms。整个序列共享原调用期限，取消通过现有 Job 取消接口，不自动重试已派发步骤。结果 dispatched 仅表示工具执行完成，effect_confirmed=false 明确未核对设备界面。

工具由旁置 automation.config.json 或 --config 绝对路径配置，请求不接受命令字符串。设备身份、坐标、步骤数和时间有界；文本仅接受安全 ASCII，避免 Android 远端 shell 二次解释。独立插件只引用公共 SDK、运行库和工具库。

新增 windows.mouse.position/click/repeat 与 input_trace.record/playback 接线。部署者须在 Windows 上显式设置 desktop_enabled=true；桌面指服务器本机，浏览器请求不代表客户端桌面。重复点击支持次数、时长及有硬上限的手动模式，运行期间轮询 F9 停止；部分按钮派发失败仅释放本次按钮，不能声明界面操作已确认。

InputTrace 由部署者配置固定工具入口，录制使用 record -s -f -t -i 和 stdin exit 正常保存；私有目标不会覆盖已有文件。回放按授权产物 ID 校验大小/SHA256、私有复制和固定 playback 参数执行。正常录制发布 recording.msgpack、operation.json 与脱敏 input-trace.log；回放发布后两者。失败不发布部分产物，清理不能确认时保留失败标志和私有目录。业务取消与截止点独立于最多两秒的退出确认宽限。

现有输入轨迹扫描接受连续十字段 MessagePack 记录，限制事件数、类型、累计时长、嵌套与文件量；当前原生工具私有格式和真实样本兼容仍待独立验证，不能以合成记录通过宣称旧文件全部兼容。服务器桌面实际点击、InputTrace真实录制/回放、F9按键和浏览器产品快捷键未验；F10/F11产品入口继续等待界面设计，不以安卓序列或静态接线表示完整自动化完成。
