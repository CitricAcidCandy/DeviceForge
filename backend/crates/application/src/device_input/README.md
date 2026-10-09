# 设备输入用例

InputOperations 注册 android.input，输入模式直接从领域 InputRequest 生成，避免手写模式漂移。HTTP 与 MCP 自动发现同一操作，并通过现有任务队列执行。

执行前拒绝未知操作、已取消请求和无效输入，再调用可替换 DeviceInput 端口；不拼接设备命令。成功返回 InputReceipt，不回显文本。

验证：cargo test -p apk-application --test device_input，覆盖生成模式与执行边界、未知字段、非法坐标 / 时长 / 按键 / 文本、预取消及端口调用次数。