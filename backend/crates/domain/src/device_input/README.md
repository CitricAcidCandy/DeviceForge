# 设备输入领域端口

DeviceInput 接收类型化 InputRequest，返回 InputReceipt。InputAction 包含点击、滑动、按键和文本四种动作，使用 kind 判别；端口不依赖 ADB、HTTP 或进程。

请求验证独立于 JSON Schema：设备编号遵循领域标识符规则，坐标为 0–32767 的整数，滑动时长 1–10000 毫秒，按键码 1–65535。文本为 1–1024 个可打印 ASCII 字符；控制字符、换行与 Unicode 文本需其他输入适配器，当前拒绝。

坐标由调用方按设备当前方向提供，领域不猜测屏幕大小。按键码上限是接口容量约束，不保证每个数值都被设备支持。dispatched 只表示输入命令完成，不证明界面变化。

验证：cargo test -p apk-application --test device_input；cargo test -p apk-infrastructure device_input。