# 应用启动外壳

main/App 保留基础外壳。runtime.ts 公开 createFrontendRuntime，装配 API、各功能公开入口、SDK 宿主、扩展注册表与插件运行管理；host-context.ts 映射 DTO 和公共错误，不执行 HTTP 或业务规则。

工厂必须传 baseUrl、transport、panelTarget，tokenProvider 可选；组件/模块目标及包 importer/resolver 按需注入。beforeTaskSubmit 接入 tasks 真实提交用例，服务器管理后刷新操作目录。dispose 幂等地取消整个宿主、释放插件及功能订阅；清理失败返回聚合错误。

slotAdapter 可注入 append/replace 与默认 renderer 的公开适配器；其所有权归注入宿主，runtime 只释放插件租约，不擅自关闭共享槽位。包入口 resolver 收到 InstalledWebPackage 和运行 UUID；每次资源路径前缀变更，保持相对依赖代际一致。

目前 main.ts 不自动构造运行实例，工厂供后续宿主交互装配及真实服务测试。没有新增页面、设备界面、UI 框架或本机桥接，页面不保存令牌。
