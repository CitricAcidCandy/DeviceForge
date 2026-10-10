# 安卓设备插件独立原帧验收

状态：编写后冻结交主代理统一 fmt、编译与真实执行。编写者未执行 Cargo、rustc、Node、npm、测试或服务。唯一写集为本插件 `tests/`，不接管生产、清单或 workspace。测试入口 `protocol.rs` 使用已有 serde_json 与标准库，无新增 dev 依赖；主代理执行测试时，通过 PATH 的 rustc 一次编译 `fixtures/adb.rs`，再复制至每个场景的独立工具目录。

## 覆盖与固定期望

| 模块 | 最小断言 |
| --- | --- |
| normal | 八短名分别实际执行；发现是公开设备数组；七能力固定 argv/原 serial/trim output；合法 failed/error 包名；独立 Success；tap/swipe/keyevent/text，单引号、字面量 `%s`、enter 多笔与1024字节正界；Restricted环境；双清单与八alias静态对照 |
| validation | 完整外部名拒绝；显式 provider null/两个字段；每层未知字段、非对象、null bool；宽 serial 原文与200 UTF-8字节，201及控制符反界；address/package/action 精确错误；空ArtifactContext合法、非空inputs先于配置拒绝；坏Request/Start零工具 |
| discovery | online/offline/unauthorized与未知 raw 原文及五项可用性；不把 provider能力写进设备项；空数组；重复/128与129整份边界；serial200、raw100、model200及越界；缺状态/控制符/型号重复/诊断/非法UTF-8整份失败，无部分结果 |
| output | 明确连接成功资格；包列表精确诊断；uninstall独立行而非子串；非零退出固定映射；INPUT-001两路非空/诊断和两路非法UTF-8；两路空白合法；失败不续下一段/enter；各路超过1MiB精确限额 |
| lifetime | Start0、延迟Start、同一次write中Start后cancel均零工具；运行中cancel/EOF/原总D到期；connect真实5s短点先于20s总D；三笔text共享原9s；错误cancel ID仍收口；每项匹配响应、无成功值、complete及同PID实际退出 |
| configuration | 逐层/重复字段、格式版本、ADB省略/null、相对目录/自由参数、目录/缺文件/非可执行工具、显式配置缺失/64KiB越界，全部精确错误且零工具 |

默认手工 Request **始终带 Some 空 ArtifactContext**，有值 `output_directory` 不作产物配置或额外副作用。另有 None、空inputs/null输出目录正对照；非空inputs独立反例即使配置坏也应先报“本批设备操作不接受输入产物”。因此真实宿主协议4空上下文接缝直接进入本组，不能仅靠 artifacts:None 宣称 P1 已覆盖。是否通过以主代理实际结果为准。

SDK期望只按公开文档/冻结文案手工写 JSON，不用生产 parse/commands/discovery 或私有hook生成自身期望。元数据测试直接读公开清单，但仅记静态对照，不算 validator 或宿主加载通过。原帧短名与 HTTP/MCP 外部完整 ID 分层；七能力预算静态显式核30000及卸载120000，不用声明证明跨61秒。

## 时点与实际进程证据

Request → 本次真实 Ready → Start → 工具原子ready → 取得本次OS PID等待句柄 → release/cancel/原D → 响应及直接进程退出。假ADB不派生daemon或子进程；每笔独立 `call-NN` 记录原 argv 长度编码、PID、ready与正常退出标记。工具始终先hold，测试在PID仍活时开启观测，Windows持有等待句柄直到退出；退出不靠marker判断。插件直接PID/退出码由拥有该Child的客户端实际wait核对，单请求只有一个响应，正常处理必须exit0。

Start0/预取消不建立任何call目录；零启动不是仅检查stdout为空。延迟Start在Ready观测后真实等500ms，传入200ms预算，证明C0未被接收时重置。5s短点测试给20s总上下文，精确原帧错误为“插件或工具执行期限已到期”，不能把它写成宿主 Timeout；HTTP分类另验。

三笔text共9s，第一/第二笔在Ready观测+3s/+6s放行，第三笔保持hold。Ready观测只作真实C0上界，不读或改内部Instant。最终错误严格“插件执行期限已到期”；完成上界包含公开2s清理与观测余量，以抓逐笔刷新9s，不调整生产预算。此组用真实进程墙钟，不用暂停Tokio时间替代工具工作；12s原帧及其它看门狗仅防卡死，不提供吞吐/尾延迟结论。

每场景成功及失败都保留私有临时根，含部署配置、工具原件、原帧、argv、PID、插件退出记录和时间观测。失败兜底仅处理本次已知直接进程并留下fallback标记，不能据其通过清理断言；不删目录冒充清理。不保存继承环境值或真实凭据，Restricted仅记录固定禁继承变量的存在性。

## 本组不关闭的边界与主代理执行

未验证真实ADB、默认共享server自动启动/保留、真实设备响应、系统设备端shell实际输入效果、设备状态回滚、server/派生树退出、真机、宿主统一发现发布门禁、锁/旧alias同Job、代际与服务在线安装/npx。`cleanup=complete`加本次客户端PID退出只覆盖声明的任务资源；不把假工具结果计真机或server回收。未构造确定性CleanupFailed资源未确认分支。

主代理冻结所有输入并接入workspace后可编译/执行 `cargo test -p deviceforge-android-device-plugin --test protocol`，随后按当前调度统一 fmt/Clippy/全门禁。已有25生产单测与本独立组分别登记，不借前组绿记录扩大本组实跑。服务窄驱动、release原包与npx须另取写权和运行证据。
