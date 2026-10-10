# 统一发现真实 Node 夹具

本目录只提供 RAW-02 根 HTTP/MCP 验收所需的自包含在线 TGZ、管理员控制与真实进程事件。不是 smoke 主程序，不实现宿主绑定、目录发布或平台工具，不表示真机、常驻连接、release/npx 已通过。本批只做静态交接，Node、测试、构建和服务均由主代理统一执行。

## 导出接口与构包

从 `fixtures.mjs` 导入：

```js
archive(files)
fixture(id, root, { protocol = 3, devicesApiVersion = 3,
  platform = 'android', executionTimeoutMs } = {})
control(item, options)
release(item, label)
events(item)
started(item, label, { timeout = 12000 } = {})
event(item, label, kind, { timeout = 12000 } = {})
cleaned(item, label, { cancelled = false, eof = true, atReturn = false,
  timeout = 12000, exitCode = 0 } = {})
exited(pid)
operation(item, name = 'discover')
```

另导出 `localId`、`otherId`、`capabilities` 和 `rawCases`。archive 直接复用既有 `../device-provider/fixtures.mjs` 的构造器，归档最多八个普通标准 TAR 条目，单文件最多 64 KiB，返回 gzip TAR 的 Buffer，不执行包脚本。正常 fixture 只有两个设备能力：device_read/read、device_write/write；都是 device 范围，发现声明模式严格为 object 且接受空对象。

`fixture` 返回：

| 字段 | 含义 |
| --- | --- |
| id / protocol / devicesApiVersion / platform | 独立插件 ID、任务协议、设备声明 API、声明平台 |
| discoverOperation | 完整操作名 `plugin.<id>.discover` |
| manifest | 在线包内公开插件清单 |
| tgz / archive | 同一份自包含 TGZ 的 Buffer，上传时使用原字节 |
| sha256 | 本份正常 TGZ 的 SHA256 小写十六进制 |
| controlDirectory / directory | 同一个管理员绝对控制目录，不是业务输入路径 |
| localId / otherId | 正常设备和混合坏观测中的另一设备本地 ID |
| invalidArchives | 分别只有清单发生受控错误的 TGZ，见后表 |

协议 2/3 与设备 API 1/2/3 可以独立组合，不推导版本。额外允许协议 1，专用于 Json 来源伪包装拒绝回归。清单不自选服务器 Node 路径，由真实宿主在线安装映射入口；包内源码仅依赖 Node 内置模块。

每个 root/id 必须是本次独占的新目录，已存在时 fixture 拒绝创建，避免覆盖另一批事件。初始化标签为 initial；API1/2 初始 rawCase=missing，API3 为 valid。executionTimeoutMs 可以省略或 null；显式值按真实安装规则检验，不在夹具替宿主放行 API1 预算。

## 管理员控制与场景

`control(item, options)` 原子写入管理员控制文件，返回实际控制快照。每个进程读取一次快照，后来改控制文件不会改变正在运行的场景；同一插件的下一次调用读取新快照。发现业务输入必须严格 `{}`，不在里面塞 label、mode、generation 或其它控制字段。每次真实执行使用一个新标签，标签限 1–80 个小写字母、数字、下划线或连字符。

| 控制字段 | 允许值或默认 |
| --- | --- |
| label | 必填，本次场景唯一标签 |
| mode | valid、hold、empty、duplicate、bad-state、undeclared-capability、mixed-bad-raw；默认 valid |
| rawCase | 下表中的名字；默认 API1/2 missing、API3 valid |
| rawState | 可显式覆盖原文，支持有界坏 JSON 类型；要省略使用 rawCase=missing，不传 undefined |
| resultMode | array、pseudo-wrapper、pseudo-wrapper-extra、object；默认 array |
| cancelMode | complete、failed、ignore；默认 complete，只控制实际取消之后的行为 |
| state | online、offline、unauthorized、unknown；默认 online，不由原文推导 |
| model | 可省略、null 或最多 200 UTF-8 字节字符串；省略时发现也省略 |
| durationMs | 正常模拟工作时间，默认 25，范围 0–35000 毫秒 |
| waitLimitMs | hold 有限等待，默认 12000，范围 0–35000 毫秒；验证30秒期限可设35000 |
| cleanupDelayMs | 清理延迟，默认 40，范围 0–500 毫秒 |
| eofTimeoutMs | 响应后等待真实 stdin EOF，默认6000，范围0–10000毫秒 |
| exitCode | 响应及 EOF 后的真实退出码，默认0，范围0–125 |

hold 等待同标签 release 文件，`release(item,label)` 解除门闩。complete 实际收到协议3取消后停止模拟工作、完成清理并发送 cleanup=complete；failed 发送 cleanup=failed 并记录 cleanup_failed，不写 cleaned；ignore 记录取消但继续等门闩，不发送提前清理响应。协议2没有合作取消控制帧；宿主结束进程的路径不能伪造为收到协议3取消。

| rawCase | 实际 raw_state |
| --- | --- |
| valid | 含首尾空格和中文的 ` Vendor.Recovery 模式 `，原样发送 |
| recovery / sideload / bootloader | 对应特殊状态原文 |
| unknown | 宿主不认识但语法合法的厂商原文 |
| missing / null | 不写字段 / 显式 JSON null |
| empty / whitespace | 空字符串 / 普通空格加全角空格 |
| unicode-control / ascii-control | 包含 U+0085 / 换行控制字符 |
| ascii-100 / ascii-101 | 100 / 101 个 ASCII 字节 |
| utf8-100 / utf8-101 | 33 个“界”加一个 / 两个 ASCII 字符，恰好100 / 101 UTF-8字节 |
| number / boolean / array / object | 明确错误的 JSON 类型 |

正常输出是一台设备的公开数组，线字段为 raw_state。empty 产生合法空数组；duplicate 重复本地 ID；mixed-bad-raw 在正常设备之后追加另一 ID 的控制符坏原文，验证整份拒绝，不让重复 ID 掩盖原文错误。

pseudo-wrapper 在业务 result 中放 `{result:[...],artifacts:[]}`；pseudo-wrapper-extra 额外加一个字段；object 放 `{devices:[...]}`。协议1可证明 Json 伪包装不取得宿主产物来源，协议2/3可证明真实外包装的业务 result 仍须数组。夹具只写公开 Response，协议3再写 `{response,cleanup}`；真正 PublishedArtifacts 包装由宿主生成，不在夹具自行制造发布证据。

## 安装失败与运行失败分开

| invalidArchives 键 | 清单错误 |
| --- | --- |
| schemaNonObject | 发现根模式为 array |
| schemaRejectsEmpty | 发现 object 模式要求额外字段，拒绝空对象 |
| missingDiscovery | discover_operation 引用未声明操作 |
| unsupportedDeviceApi | 设备声明 API4 |
| budgetZero / budgetOverflow | API3 能力预算为0 / 120001毫秒 |
| legacyBudget | API1 声明显式非 null 能力预算 |

这些归档供安装400 invalid_input的精确断言；不能把失败笼统写成任意4xx。raw 不合法、重复设备、坏枚举、未声明能力和伪包装均使用正常归档安装，再由 control 产生运行输出，预期发现502 dependency_failed或已准入Job失败，而不是安装失败。

platform 可构造 android、harmony 或其它合法声明。专用旧数组 profile 的 platform 匹配/错误、API3及本次原文必填，由 Kuhn 在真实宿主绑定配置/load/发现处断言。此目录不生成绑定配置，不猜 InputMapping tag，不把 raw_state 自行投影为旧数组 state，也不模拟宿主目录或接受回执。

## 真实事件与清理证据

每行事件包含 kind、at（Unix毫秒）、sequence（本进程序号）、pid、provider_id、request_id、operation、label、scenario、protocol、devices_api_version。scenario 是 `mode/rawCase/resultMode/cancelMode`；不记录业务输入、raw原文、令牌或任意插件输出。events 只返回完整JSONL行，坏完整行不吞掉，文件上限2MiB。

| kind | 实际事件边界 |
| --- | --- |
| started | 已读取控制并验证业务输入，本次模拟工作开始 |
| released | 真实观察到本标签 release 文件 |
| cancel_received | 收到匹配 request_id 的真实协议3 cancel控制帧 |
| cleaned / cleanup_failed | 模拟计时工作及短清理等待已结束 / 本次明确报告清理失败 |
| response_written | stdout.write回调完成，协议响应已写入管道 |
| stdin_eof | process.stdin实际收到end，不能用readline.close替代 |
| stdin_disconnected | 协议3在响应前实际断流，结束本次工作；不冒充收到cancel帧 |
| readline_closed | readline输入界面关闭，独立于真实EOF事件 |
| process_exit | Node真实exit回调，附exit_code |
| fixture_failed | 夹具自身有限等待、帧或I/O失败；不是成功清理证明 |

协议2正常先收到EOF再完成响应；协议3故意响应后等待宿主EOF才零退出，覆盖取消响应后的断流处理。cleaned 同时检查真实清理事件、响应事件、EOF、exit事件和记录PID已不存在；cancelled=true额外要求真正收到取消帧，atReturn=true只检查当下状态，不补等待冒充返回前已完成。

强制结束可能没有Node exit回调，不能补写process_exit或cleaned。exited只使用信号0探测已有PID，不结束任何进程。模拟资源只有本次计时器和输入流，这些证据不能扩大为外部设备、共享daemon或真机资源清理；one Job/一次执行、目录接受和终态竞争仍须宿主HTTP/MCP及存储断言。
