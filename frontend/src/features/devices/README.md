# 设备提供者基础用例

公开入口 createDevices 接收四类公开模型网关，返回 refreshProviders/refreshDirectories/refreshProvider、select/snapshot/subscribe、invoke 与 dispose。app 负责从生成 HTTP DTO 显式映射到独立 SDK 模型；本功能不手写 HTTP DTO、不引用其他功能内部实现，也不根据 platform 分支执行工具。

rules.ts 只比较完整设备引用及提供者代次、观测/状态和精确能力版本；requests.ts 负责取消等待与晚到拒绝。目录、选择和在途请求属于运行实例，插件使用相同公开设备能力但由 scope 包装实例/挂载子信号。

刷新失败清除对应代次旧观测，未知提供者/精确能力版本/设备为 not_found，旧代/未观测/离线/不可用为 conflict，输入与作用域错误为 invalid_input。这些客户端检查不替代后端原子任务准入；已提交任务与目录观测不是持续设备在线保证。

当前只有基础用例，没有产品设备页、常驻传输或后台推送。设备真实服务、真机与前阶段在线浏览器验收分别记录。
