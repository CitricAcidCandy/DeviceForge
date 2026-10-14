
# Android指标部分缺测实施裁定

日期：2026-10-13。模式architecture-first / Hybrid，当前Android采集授权内的兼容增量；不做新业务、产品UI、性能专项或唤醒手机。目标是明确不可用的系统CPU/内存接口只使对应指标缺测，仍保存同一采样点的合格FPS、环境和画面；无Root继续普通采集。

## 合同与选择

选择扩展既有PerformanceSample/RawPerformance/Reading，不建重复DTO，也不填零或沿用旧值。pidof及首末/proc/PID/stat和process_start_ticks仍必要，process_ticks仍u64；系统system_ticks和logical_cpus改为Option且必须同有/同无；pss_kib改为Option，内存明确不可用时PSS/RSS同时无值。Reading的logical_cpus/pss_kib同步nullable。健康旧JSON数字保持可读。

新增可选metric_missing={api_version:1,cpu:UnavailableMetric|null,memory:UnavailableMetric|null}，只有真实缺测项存在，空对象拒绝；UnavailableMetric={source:string,access:既有ObservationAccess,reason:permission_denied|unsupported}。source为1..80字节稳定ASCII标识。cpu条目必须且仅对应system_ticks/logical_cpus同为空；memory条目必须且仅对应pss_kib/rss_kib同为空。缺metric_missing的旧样本仍要求原数值全部齐，任何矛盾、未知版本/字段/来源/原因拒绝。不改变原时间、FPS和设备观测资格。

PerformanceAccess/宿主声明及ProbeCapabilities新增partial_metrics，旧缺省false；Android API2绑定显式声明true，API1不允许新能力。宿主只在本代已声明partial_metrics时接纳metric_missing，归属/时间/数据资格沿既有严格准入。原条目与SQLiteJSON历史不迁列，存储只经Raw验证，空CPU断差分基线，恢复后的首个有效样本只建新基线、下一有效样本恢复百分比，不跨缺测插值。

仅精确固定只读命令的明确权限拒绝/接口不支持诊断归为不可用；捕获租约/退出/清理已确认后才分类。成功输出须全是已认可诊断、不可混合数据；非零退出只能在code=1且完整stderr匹配诊断时缺测，此路径公共工具库不保留stdout，因此不复用任何数值。Spawn、离线、unauthorized、任意未知诊断、无匹配退出、缺header/PSS、wrongPID/重复身份/非法计数/结构矛盾仍硬失败。原D、两流限额、取消、EOF、到期、CleanupFailed不被缺测吞掉。普通设备动作和全局ToolError映射不改变。

## 职责与独占写权

| 单元 | 输入输出/职责 | 副作用与边界 |
| --- | --- | --- |
| 主代理：SDK performance/metric_missing及lib，domain performance/metric_missing及mod | 独立纯类型/严格缺测规则、原字段Option、CPU连续基线和Reading | 无设备I/O，SDK与domain显式镜像，不互相依赖 |
| 主代理：声明/注册/来源映射和采样准入、旧Probe构造与公共回归接线 | partial_metrics缺省/显式资格与旧路径构造 | 不增加宿主Android命令、不改worker终态/期限 |
| 后端：android-device/control及rules/performance/missing、session/performance、profile/derived、双清单及所属库/协议回归 | 原执行器类型化读取分类、已确认Root通道、采样与Root录制nullable派生 | 固定argv/有限进程；不改公共工具库、帧采集或真实Root资格 |
| 前端：performance/results与android-profile/types/metrics/derived及对应测试 | 消费生成nullable合同、缺测原因/值联动、旧档案兼容 | 不生成重复类型、不做产品UI或手改generated |
| 测试助手：新的部分缺测实服驱动及SQLite存储回归独立文件 | 手工原诊断/有效→缺测→恢复、原HTTP/MCP/归档/历史和OS退出 | 不运行构建/服务/ADB；主代理统一执行 |

现有采集、解析、派生已分文件。控制器新增薄指标分类入口复用同一capture_scoped_command，不复制执行器；纯拒绝诊断独立模块，领域新增纯规则模块，避免往编排文件堆规则。

## 验证顺序和边界

先证纯字段资格与明确诊断/数据混合拒绝、旧JSON兼容；各角色冻结后由主代理生成、定点、全后端必要门禁（Cargo-j1避1455）和前端完整检查，再独立冻包实服。关键矩阵：有效A→缺测B→恢复C→有效D，B保持sequence/其他原值与明确原因，C无跨B差分，D恢复；缺测后身份/取消/原期限/限额/未确认清理仍无部分发布。真实Root、匹配符号、OEM精度/游戏独占功耗和Release分发独立待验；本批不宣称每温度缺测原因已完成。

## 2026-10-13实际验证

最终完整门禁：架构27/Node6、fmt、Clippy、workspace test/build退出0；顶层136组1768项通过，AI内部单测输出单列不合计。1121维护输入和342前端输入、29驱动文件前后大小/摘要一致。前端69文件625项通过，新8项逐名验证，可空generated索引已同步。两失败门禁原件及公共smoke环境首次失败均保留。

最终冻包host064a4408…/Android e6488d24…/清单238cb8cd…独立通过两部分缺测会话和两Root媒体归档任务；128直接工具原件及实际前端/ZIP消费单独审计，合成UID0/simpleperf和TCP媒体不证明真实Root或scrcpy设备精度。正常A→缺测B→恢复C→有效D序列在真实SQLite重开回归验证；实服首样立即stop只证明单点缺测，不借序列结论。最终公共运行五检查通过，全自有进程结束，三星息屏。证据见../../artifacts/android-partial-metrics-7bb5579b-7a55-4f9b-a965-1f35c7c25e7b及根最新交接。

终包两PNG经视觉子代理审核，与选中黄金及已审核图片逐字一致（SHA0cafe728…30e96），64×48黑灰白渐变可辨识；新ZIP/index/历史产物及sample.index=frame.index、帧PTS与设备目标/误差关联成立。视觉记录位于最终media目录frontend-visual-audit.json，仅合成媒体归档，不是当前游戏真机画面。

最终独立审计已冻结：backend-independent-audit.json（SHA587c268b…54b12a），确认18项缺测回归与1项Frida测试oracle逐名通过、终包128工具的双流原字节/OS创建身份/退出、两ZIP CRC/index/PNG/perf/4栈及实际前端联合消费均符合；初包及失败轮分别保留，不转计。最终视觉审计见终包media目录frontend-visual-audit.json，图像结论限于合成媒体。
