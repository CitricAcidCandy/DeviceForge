# 设备提供者 API

GET /api/v2/device-providers 返回 DeviceProviderInfo[]；GET /api/v2/devices 返回当前代 DeviceDirectory[]。POST /api/v2/device-providers/{id}/refresh 的对象仅含 generation，等待本次显式发现完成后返回目录；POST /api/v2/device-actions 使用 DeviceActionRequest，返回 202 Job。均采用 v2 包装与可选令牌检查。

MCP deviceforge.list_device_providers/list_devices/refresh_devices/invoke_device 使用同一 DeviceService；刷新参数为 ProviderInput。动作与直接 jobs 都进入同一任务准入、所有权、设备锁和历史。

错误明确区分 400 invalid_input、404 not_found、409 conflict/cancelled 和 502 dependency_failed；失败发现清除当前目录。没有隐式背景发现、平台名称选择、常驻连接或全平台迁移声明。
