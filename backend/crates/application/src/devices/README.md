# 设备目录与能力任务

DeviceService::new(app) 与 HTTP/MCP 共用 Application。提供者声明在原贡献准备阶段验证，原子发布，目录写入与 owner 代际复核使用同一注册锁；卸载同时撤销目录。GET 只暴露当前加载代际。

refresh、直接discover Job与格式2显式发现别名共享同一Application两项在途额度和跨代provider串行。30秒总期限从存储工作池之前准入起算，涵盖排队、终态存储与目录接受；串行许可和额度持有到本attempt裁定及清理收敛。同步开始门禁通过才清旧目录，排队、坏输入和门禁前取消/到期保留旧目录；门禁后取消可零实际进程但目录已清，不据此声称工具已启动。

发现观测由纯observation模块按真实执行器来源解码和验证，attempt模块只裁定Pending/Cancelled/Accepted与有界回执。成功历史先持久化，目录再在registry→attempt门禁中接受，二者不是跨资源事务；历史Succeeded可以因随后取消/到期/卸载而没有当前目录。refresh只消费本Job回执，不取GET最新目录代替。卸载撤销当前目录与Pending尝试，历史保留；重启不从历史自动恢复可动作观测。

submission_reservation只管理创建中的有界预留和application/owner排空凭据。准入锁在store.create前释放，创建结束后重检停止、代际、取消、原期限和清理；合法运行双tracker登记后再释放预留。关闭可立即取消Creating但仍等待不可撤销创建及其历史补偿，卸载同样等待旧owner；晚形成的历史不表示关闭后接受新任务。所有存储I/O都在准入锁外，创建失败或补偿失败显式保留错误和历史关联。

provider/localID 锁键跨代共享。provider write 持写屏障；所有 device 动作和 provider read 持读屏障，device write 另持本地设备 Mutex。弱引用升级与创建原子进行；获锁后复核取消，守卫覆盖原执行器清理。直接 jobs/MCP 由固定 operation 声明选择 scope/access，输入只能提供标准封套，不可覆盖读写标记。

设备能力任务从准入起默认 30 秒总期限；API 2/3 可声明 execution_timeout_ms，上限 120 秒。设备锁、全局执行槽、产物准备、执行和发布共用截止点，经 ExecutionContext 传入执行器。发现默认 30 秒，直接 jobs 同样受限，刷新子任务继承刷新起的截止点；发布目录在注册锁内复核期限。到期取消后最多再给原执行器 2 秒清理时间，期间仍持设备锁。排队超时不启动执行器。历史 cleanup_failed 只保留诊断，不拒绝新提交、排队执行或独立发现；本次真实清理失败仍记录失败，取消、期限、当前代际和设备写锁继续生效。

声明只检查标准封套结构、显式字段类型和模式可编译性，不以固定设备 ID 或空业务 input 判定能力可用；真实输入在提交时完整验证。协议 2/3 可用现有输出产物及 artifacts.input_pointers 嵌套输入选择，实际副本、输出和分发证据见根 todo.md；业务输入不能选择未声明产物或服务器路径。

未知提供者/能力精确版本/设备为 not_found；旧代、无观测、离线或不可用为 conflict；坏发现为 dependency_failed；封套/版本/input 错误为 invalid_input；刷新取消为 cancelled。此阶段只有第三方离散能力，既有平台迁出、跨提供者物理别名和常驻连接仍待后续。
