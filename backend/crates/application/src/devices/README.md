# 设备目录与能力任务

DeviceService::new(app) 与 HTTP/MCP 共用 Application。提供者声明在原贡献准备阶段验证，原子发布，目录写入与 owner 代际复核使用同一注册锁；卸载同时撤销目录。GET 只暴露当前加载代际。

刷新最多两项在途，同 provider 串行，每次先撤销旧目录；失败或取消后无可执行观测。30 秒等待期限，客户端 Future 丢弃取消本次发现，后台仍持许可到原任务清理完成。发现任务历史保留，无隐式背景发现。

provider/localID 锁键跨代共享。provider write 持写屏障；所有 device 动作和 provider read 持读屏障，device write 另持本地设备 Mutex。弱引用升级与创建原子进行；获锁后复核取消，守卫覆盖原执行器清理。直接 jobs/MCP 由固定 operation 声明选择 scope/access，输入只能提供标准封套，不可覆盖读写标记。

未知提供者/能力精确版本/设备为 not_found；旧代、无观测、离线或不可用为 conflict；坏发现为 dependency_failed；封套/版本/input 错误为 invalid_input；刷新取消为 cancelled。此阶段只有第三方离散能力，既有平台迁出、跨提供者物理别名和常驻连接仍待后续。
