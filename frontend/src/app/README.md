# 应用启动外壳

`bootstrap.ts` 提供无界面装配入口 `createFrontendBootstrap`。它接收宿主根节点、API 传输和可选挂载目标，构造公开 runtime，并把主题目标默认绑定到该根节点；它不加载插件、不发起业务请求，也不创建产品页面。返回值的 `dispose` 具备幂等等待语义，适合测试和宿主自行管理生命周期。

`main.ts` 在浏览器启动时创建 React 产品根和独立插件根，通过 `product/services.ts` 装配公开工厂，API 默认使用当前页面 origin。插件不能替换 React 私有工作区，只能使用已登记的 `workshop.extensions` 或独立面板/模块根。页面离开时释放实例、媒体、插件槽位与 React 根，清理失败保留错误。

`product/App.tsx` 管理产品路由与已访问页面，隐藏切页保留草稿与长会话。runtime.ts 公开 createFrontendRuntime，装配 API、各功能公开入口、SDK 宿主、扩展注册表与插件运行管理；host-context.ts 装配公开操作/任务及可选设备、产物和任务历史访问，不执行 HTTP 或业务规则。

工厂必须传 baseUrl、transport、panelTarget，tokenProvider 可选；组件/模块目标及包 importer/resolver 按需注入。beforeTaskSubmit 接入 tasks 真实提交用例，服务器管理后同步操作与设备目录。dispose 幂等地取消整个宿主、释放插件及功能订阅；清理失败返回聚合错误。

public-api.ts 共享 Operation/Job 与错误映射；device-gateway.ts 显式转换生成 snake_case DTO 与独立 camelCase SDK，保留真实日志 ID；device-host.ts 合并根生命周期信号、检查关闭并释放订阅。runtime.devices 已实际接入 HostContext.devices，不暴露令牌或私有模块。

catalog-refresh.ts 编排本实例 server load/unload 后的目录协调：成功、失败或取消均先撤销目标设备缓存/选择和相关请求，再重查 operations 与 devices。重查失败不保留目标旧观测，远端变化通过显式刷新获知；功能之间不跨内部导入。serverPlugins/pluginPackages 是 app 管理入口，不通过设备公开适配授予插件。

artifact-gateway.ts 接收 runtime 已有上传/下载端口，校验生成 ArtifactDto 并显式映射独立 SDK Artifact，publicCall 保留错误及响应日志；网关合并 caller/runtime 信号，关闭后零新调用，晚到结果拒绝。createHostContext 的第五个可选参数注入原传输并提供 HostContext.artifacts；原四个参数含义不变，原 runtime.artifacts 的 snake_case 上传响应/Blob 下载保持兼容。SDK 仅开放原字节传输，不增加查询预览、删除、路径或令牌；本次源码及回归待主代理门禁，未计入历史 LAN 验收。

task-history-gateway.ts 注入既有任务 list/get/events 端口，纯映射 HistoricalJob 与 JobEvent，并校验查询、安全整数、事件顺序及精确任务关联。生成类型不进入 SDK；publicCall 保留 HTTP/协议错误日志，复用传输取消等待以兼容忽略信号或永不返回的端口，结果交付前再次复核取消。createHostContext 的第六个可选参数注入 TaskHistoryTransport，旧调用可省略；runtime 传入现有 tasks，不改变 runtime.tasks 或旧 Job/getJob 形状。历史不补当前目录元数据，不产生缓存、轮询或 cancelJob 副作用；本批回归尚未执行，主代理统一门禁和真实生产验证。

slotAdapter 可注入 append/replace 与默认 renderer 的公开适配器；其所有权归注入宿主，runtime 只释放插件租约，不擅自关闭共享槽位。包入口 resolver 收到 InstalledWebPackage 和运行 UUID；每次资源路径前缀变更，保持相对依赖代际一致。

目前 main.ts 不自动构造运行实例，工厂供后续宿主交互装配及真实服务测试。没有新增页面、设备界面、UI 框架或本机桥接，页面不保存令牌。

生产公开入口 /assets/plugin-host.js 导出 createFrontendRuntime/createNamedSlotAdapter，由消费方以原生 ESM 装配；设备第一阶段不包含后台推送、常驻传输或平台工具。
