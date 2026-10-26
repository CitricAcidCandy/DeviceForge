# 插件依赖管理

统一管理完整发布、服务器插件和浏览器插件的后端电脑依赖，不探测浏览器客户端或已连接设备。正常安装一次点击，由宿主自动检测并复用本机与 `.deviceforge` 的兼容依赖，缺失必需项自动下载和绑定；不要求另点依赖安装。面板用于失败补救、依赖后来失效后的重新检测和可选工具补装。空配置的自动发现由后端执行，前端不要求先填写工具路径，也不根据市场描述拼装依赖。

- `services/http.ts`：通过公开 API 客户端与生成 DTO 端点调用依赖 GET、scan/install POST，映射领域模型；组件归并到完整发布后使用宿主返回的 canonical target。
- `models/dependencies.ts`：独立目标用例、订阅、任务运行器、有界等待、取消和迟到隔离；任务终态后重新 GET，不推断任务结果结构。
- `utils/rules.ts`：安装资格与缺失必需依赖选择；可选依赖只经用户逐项安装。
- `types/index.ts`：消费模型与用例状态，不含 UI、全局装配或安装用例。

HTTP 路径为 `/api/v2/plugin-dependencies/{release|server|browser}/{id}`；写操作在同路径下的 `/scan` 与 `/install`，始终携带当前 `expected_revision`，逐项及批量安装携带选定 `dependency_ids`。不自动重放写操作。停止等待不发送服务器取消；已接纳的任务可通过公开作业运行器继续查询。终态失败保留错误日志 ID，随后成功不会抹除历史错误。等待上限默认两分钟，可注入选项；销毁取消本实例的订阅和等待。

API 输入输出从生成 `paths` 索引，领域消费模型从 DTO 派生，不维护手写协议副本。任务轮询同时按序列读取公开事件，展示后端阶段及字节；总量未知时保持不定进度，不伪造百分比。事件不可读只保留独立诊断，不把已确认的任务成功改成失败。

独立浏览器插件经 `PackageActions.enableBrowser` 启用前先 GET，必需项未就绪不得导入或激活，空依赖直接通行；默认启用复用这一入口。完整发布仍由安装状态门禁管理。依赖补救成功后市场重新恢复当前安装目录，沿宿主原启用意图同步浏览器，不重复提交启用操作。

浏览器扩展可选使用 `host.extensions.callService('host.plugin-dependencies', '1', { action: 'get', target: { kind: 'browser', id: 'example' } }, signal)` 查询。服务由 `app/plugin-dependencies-service.ts` 注册，只接受 `get` 与严格目标，不安装、不下载；检测仍由后端完成，返回 canonical 目标与真实日志 ID。未提供此服务的旧宿主由公开机制报告服务不可用，未新增 `HostContext` 必填方法。

市场私有 UI 位于 `pages/marketplace/components/PluginDependencies/`。真实服务、生成类型集成、浏览器视觉与整包验收由主代理统一排程。
