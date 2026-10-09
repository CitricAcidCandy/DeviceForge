# 设备提供者 API

GET /api/v2/device-providers 返回 DeviceProviderInfo[]；GET /api/v2/devices 返回当前代 DeviceDirectory[]。POST /api/v2/device-providers/{id}/refresh 的对象仅含 generation，等待本次显式发现完成后返回目录；POST /api/v2/device-actions 使用 DeviceActionRequest，返回 202 Job。均采用 v2 包装与可选令牌检查。

MCP deviceforge.list_device_providers/list_devices/refresh_devices/invoke_device 使用同一 DeviceService；刷新参数为 ProviderInput。动作与直接 jobs 都进入同一任务准入、所有权、设备锁和历史。

错误规则固定：未知提供者、精确能力版本或设备为 404 not_found；旧 generation、未观测、offline、能力不可用或未确认资源为 409 conflict；语法、缺字段、非对象 input、非法 version 和作用域封套为 400 invalid_input；坏发现、重复 localID、未声明能力为 502 dependency_failed；刷新取消为 409 cancelled，期限耗尽为 504 timeout。HTTP 与 MCP 保留相同领域错误码，不以任意 4xx 代替准确结果。

刷新开始清除当前目录，失败/取消后保持无观测；列表只暴露当前加载代际。刷新两项在途且同 provider 串行，30 秒总期限覆盖排队与发现。能力任务从准入起 30 秒覆盖锁等待/执行槽/执行，到期再给原任务最多 2 秒清理。没有隐式背景发现、平台名称选择、常驻连接或全平台迁移声明。

SDK 声明允许业务 input 中有必填字段和设备 ID pattern/enum；实际提交完整校验。现有输出产物可用，嵌套 input.artifact_id 不由顶层 artifacts.input_fields 解析，平台提取前须另设计；默认免鉴权与可选令牌不表示平台或真机已完成。
