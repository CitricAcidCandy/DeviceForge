# 完整工具范围的原生多代夹具

本目录只提供真实Windows进程和独立定点自检，不实现或替代公共`scoped`执行器。源码仅依赖Rust标准库及Win32，直接`rustc --edition=2024 -D warnings main.rs -o 绝对输出目录/scoped-tool.exe`编译，不运行共享Cargo、不修改旧测试。源码、文档使用UTF-8。

## 入口与身份

调用前创建本轮独占绝对证据目录，将36字符随机UUID原字节写入`owner`；程序参数使用独立argv：

    scoped-tool.exe --evidence <绝对目录> --nonce <UUID> --role root --scenario tree --pipe closed --root-exit-code 0

`tree`固定派生root→child→grandchild两代后代。`launcher`是自检用外围启动器，生产公共API测试直接启动`root`；`recover`是树外独立回收入口。每个角色原子发布`ready-角色.json`，包含PID、实际程序、字符串形式创建时间、直接父PID、本轮身份、实际子PID和界限。`handles-角色.json`记录真实标准句柄类型/继承位；未记录任意环境内容。

每角色独立`release-角色`门闩，只接受ASCII字节`1`，应经临时文件原子重命名发布。默认20秒自有看门狗，允许3000–60000毫秒；叶子释放后可用`--delay-ms`设置0–2000毫秒迟到退出。`--root-exit-code`允许0–255，根以该真实退出码结束，后代及启动器正常退出0。`exit-intent`和`watchdog`只记录退出意图，均明确不是OS终态。

`--pipe inherit`让子孙实际继承当前标准输出/错误管道，每角色写唯一`DF_SCOPED:角色:UUID`行。定点验证先确认父OS退出，再确认后代持管道时EOF仍未发生，最后确认全树结束与EOF；这不是任意第三方程序的句柄策略资格。

## 现有OS探针与独立回收

使用已有`process-probe-observable.exe`的稳定目标及直接父句柄。公共API测试只须先为`child/root`和`grandchild/child`两对取得ready，两探针共同覆盖三角色，避免把长时间运行的测试宿主当成必须退出的父。自检多用一对`root/launcher`，覆盖外围启动器。全部角色创建身份必须与探针逐项相同，释放门闩或发取消前必须已取得全部句柄。

真实终态以探针实际exit0、`.exit.json`的Wait信号/退出码与创建身份为准；单次`.request`必须原子发布ASCII`1`，可取得父已经退出而子仍存活的真实状态快照。创建时间相同但跨探针观察时间不同，不用于声称精确退出先后。

独立回收前写`owned.tsv`，每行严格为`PID<TAB>创建时间<TAB>角色`，最多四个、不允许重复。回收器先取得所有精确句柄，核对创建身份；需要终止的存活进程还核实际程序路径，再按后代到父顺序终止并实际等待退出，回收退出码73。已退出句柄只读真实终态，不再查询可能失效的程序路径；不可打开仅记`unavailable/os_exit_confirmed:false`。PID身份不匹配时拒绝操作。回收报告明确`test_kill:true`及`public_scope_verified:false`，不能补记公共取消或Drop成功。

## Breakaway边界

`breakaway`仅用于原生自检：根主动加入本次明确的默认禁止breakaway Job，然后实际尝试`CREATE_BREAKAWAY_FROM_JOB=0x01000000`，记录真实CreateProcess结果；本机观测为失败/Win32错误5。若意外成功，立即记录PID并回收该直接句柄，不把结果写成拒绝。

公共API测试必须用`breakaway-external`：夹具不增加私有Job，仅记录调用方现有Job归属再实际尝试，避免自建Job掩盖公共执行器缺陷。任何`IsProcessInJob(NULL)`布尔值只表示属于某个Job，不能单独识别公共范围Job。本模式须等待公共API接线后另验，当前定点自检不计它通过。

## 实际证据

最新标准库编译程序为`artifacts/scoped-process-fixtures-fec818d8-9248-40d3-9d41-b78566abd610/scoped-tool.exe`。实际入口：

    node backend/crates/tool-process/tests/scoped-fixtures/selfcheck.mjs --binary=artifacts/scoped-process-fixtures-fec818d8-9248-40d3-9d41-b78566abd610/scoped-tool.exe

2026-10-12实际退出0，报告`artifacts/scoped-process-selfcheck-021b7b83-d29d-4b4a-a3cb-821f3278b49d/report.json`：九场景、34原生角色、25现有OS探针、三独立精确回收，十输入与两个程序快照前后稳定。覆盖父先退出而两代仍活、父退后回收、两代独立门闩、根非零7、取消/Drop待测状态、500毫秒迟到、继承管道及私有Job下实际breakaway拒绝。

原七场景报告`fc3042cb-861a-4adf-a7cb-246699e5b05e`保留；新增父退后回收首次失败`41e3e020-f6b6-46fd-b6a6-786e5b8daf25`及诊断复现`4a95b3e1-53e0-472a-9d65-b9ad560ee2a7`保留，真实stderr为“读取本轮程序身份失败”。只修退出句柄的只读终态分支，随后八场景`c72da682-568c-4573-9e30-910b48cdc525`与非零增量九场景`fe645bbd-6af8-4719-8b62-d285d86c7c54`通过。各轮源码/程序身份只在本轮范围内计证据。

## 公共API接线证据

`tests/scoped.rs`在Windows真实调用`spawn_scoped_stream`与`spawn_scoped_stream_with_lease`。固定十一项覆盖预取消不启动、预置输入拒绝、公开OwnedTree策略、正常退出、根非零7、父先退但两代后代继续存活、取消、绝对期限、丢弃会话与租约、继承管道，以及不加私有Job的实际breakaway拒绝。夹具由每个测试进程只编译一次，编译发生在短绝对期限创建之前，完整argv从`--evidence`开始逐项保留。

2026-10-12第一次接线修复后曾实际得到9/11：短deadline在启动阶段超时，根退出触发公共Job终止后代。修复测试启动预算和生产生命周期后，又实际得到9/11：正常与非零根退出后输入流未结束。以上失败不计通过；生产分别修复后，`artifacts/scoped-api-final-20261012-run.stdout`记录十一项全部通过。后续主代理的固定清理截止点版本亦另有十一项完整运行原件。

租约用例把唯一`Arc`直接交给公开API，用例不保留副本。实际释放回调检查三个已取得的稳定OS句柄全部退出，避免把测试自己持有租约导致的未释放算成API证据。deadline使用三秒原绝对预算与一毫秒清理确认预算；调度可能让真实收口返回Complete或Failed，测试记录实际结果，不要求每次偶然进入Failed。本轮`artifacts/scoped-api-api-deadline-00000000-0000-0000-18dd-dc1c166cca00/report.json`实际返回Failed，返回时三句柄尚未全退出，随后唯一租约实际回调确认三句柄全部退出。报告保留`public_scope_verified:false`和外围回收标记，不把之后的独立回收当作返回时Complete。

继承管道oracle先收齐三个角色的真实标记，再确认根稳定OS句柄已退出、子孙句柄仍存活，接着确认200毫秒内输出流不能提前EOF，最后分别释放子孙并检查公开scope为Complete与三角色真实退出。最新定点通过原件为`artifacts/scoped-api-pipe-oracle-20261012.stdout`；报告`artifacts/scoped-api-api-pipes-00000000-0000-0000-18dd-dc48f20809a4/report.json`保存实际标记、延迟EOF、三角色退出码0和两OS探针退出原件。

公开breakaway定点通过原件为`artifacts/scoped-api-breakaway-oracle-20261012.stdout`；报告`artifacts/scoped-api-api-breakaway-00000000-0000-0000-18dd-dc4b5feaff74/report.json`记录未加私有Job、实际CreateProcess失败与Win32错误5、根稳定句柄退出码0、公开scope Complete。仅凭环境Job布尔值仍不用于识别公共Job。

尚未覆盖启动Future丢弃的确定性竞态、成员归属失败、监督回执丢失、租约清理失败的确定性故障注入、任意工具的句柄与逃逸策略。Linux/macOS未取得运行资格；真实工具、插件服务、正式包与性能亦不在本测试集完成范围。
