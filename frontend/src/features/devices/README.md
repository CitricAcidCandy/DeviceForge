# 设备提供者基础用例

公开入口 createDevices 接收四类公开模型网关，返回 refreshProviders/refreshDirectories/refreshProvider、select/snapshot/subscribe、invoke 与 dispose。app 负责从生成 HTTP DTO 显式映射到独立 SDK 模型；本功能不手写 HTTP DTO、不引用其他功能内部实现，也不根据 platform 分支执行工具。

rules.ts 只比较完整设备引用及提供者代次、观测/状态和精确能力版本；requests.ts 负责取消等待与晚到拒绝；state.ts 持有只读快照与整体/单提供者观测修订，index.ts 编排用例。目录、选择和在途请求属于运行实例，插件使用相同公开设备能力但由 scope 包装实例/挂载子信号。

refreshDirectories 读取提供者及已有观测，不隐式发现。refreshProvider 开始即清本代旧目录与选择，并在清理后记录修订；失败保持空，成功能发布，替代请求或旧请求失败不会清掉新目录，不同提供者可并行刷新。未知提供者/精确能力版本/设备为 not_found，旧代/未观测/离线/不可用为 conflict，输入与作用域错误为 invalid_input。这些客户端检查不替代后端原子任务准入；已提交任务与目录观测不是持续设备在线保证。

app 在本实例服务器管理后调用 invalidateProvider(id) 撤销目标缓存、选择和相关请求，再 refreshDirectories；失败仍不保留旧观测，远端管理需显式刷新。invalidateProvider/dispose 属于 app 用例管理，SDK 只暴露目录、选择、动作与订阅。

当前只有基础用例，没有产品设备页、常驻传输或后台推送。设备真实服务、真机与前阶段在线浏览器验收分别记录。
