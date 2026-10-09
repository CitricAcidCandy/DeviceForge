# 应用启动外壳

main/App 保留基础外壳。runtime.ts 公开 createFrontendRuntime，装配 API、各功能公开入口、SDK 宿主、扩展注册表与插件运行管理；host-context.ts 装配公开操作/任务及可选设备访问，不执行 HTTP 或业务规则。

工厂必须传 baseUrl、transport、panelTarget，tokenProvider 可选；组件/模块目标及包 importer/resolver 按需注入。beforeTaskSubmit 接入 tasks 真实提交用例，服务器管理后同步操作与设备目录。dispose 幂等地取消整个宿主、释放插件及功能订阅；清理失败返回聚合错误。

public-api.ts 共享 Operation/Job 与错误映射；device-gateway.ts 显式转换生成 snake_case DTO 与独立 camelCase SDK，保留真实日志 ID；device-host.ts 合并根生命周期信号、检查关闭并释放订阅。runtime.devices 已实际接入 HostContext.devices，不暴露令牌或私有模块。

catalog-refresh.ts 编排本实例 server load/unload 后的目录协调：成功、失败或取消均先撤销目标设备缓存/选择和相关请求，再重查 operations 与 devices。重查失败不保留目标旧观测，远端变化通过显式刷新获知；功能之间不跨内部导入。serverPlugins/pluginPackages/artifacts 是 app 入口，设备公开适配不自动授予插件管理/产物能力。

slotAdapter 可注入 append/replace 与默认 renderer 的公开适配器；其所有权归注入宿主，runtime 只释放插件租约，不擅自关闭共享槽位。包入口 resolver 收到 InstalledWebPackage 和运行 UUID；每次资源路径前缀变更，保持相对依赖代际一致。

目前 main.ts 不自动构造运行实例，工厂供后续宿主交互装配及真实服务测试。没有新增页面、设备界面、UI 框架或本机桥接，页面不保存令牌。

生产公开入口 /assets/plugin-host.js 导出 createFrontendRuntime/createNamedSlotAdapter，由消费方以原生 ESM 装配；设备第一阶段不包含后台推送、常驻传输或平台工具。
