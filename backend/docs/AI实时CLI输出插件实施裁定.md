# AI 实时 CLI 输出插件实施裁定

日期：2026-10-12。用户要求研发与测试并行、普通缺陷集中回修。本批独占 `plugins/ai-assistant/**` 与本文，复用公开协议5会话及既有持久线程，不给宿主增加 AI 业务分支。原协议4五项贡献保留。

## 旧行为与资格

旧 `case_assistant/index.ts` 的 `sdk:session` 门面实际调用 CLI interactive，结束后一次推正文；真实 SDK 子域另由 `runStreamed` 消费事件。迁移不能按入口名认定 SDK 已完成。现 AI 插件已有 UUID、项目归属、跨进程锁、轮次与 uncertain，本批增加 `cli.stream` 独立会话贡献。

本机 `codex-cli 0.162.1` 的 `exec --help` 明确 `--json` 为 JSONL、`-` 从标准输入读提示词。实际读取的[官方非交互文档](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable)给出 thread.started、turn.started、item.*、turn.completed、turn.failed、error。该命令/文档资格不等于已连接实际模型。

## 公开输入与输出

清单 `sessions` 声明协议5与 `cli.stream`，总期限600000毫秒。Open 输入只接受 `project_id`、`prompt` 与可选 UUID `thread_id`，规则沿用当前 CLI。传输 `session_id` 与提供者 `thread_id` 分开。一次会话运行一轮；恢复下一轮重新 Open，仍按持久线程归属和 uncertain 判断。

提示词只来自 Open，由插件发送一次后关闭工具标准输入。额外 Input 为业务错误，触发取消并等待直接进程清理；EOF只结束客户端输入，不表示模型完成，也不取消已提交提示词。宿主取消、超时与传输断开沿公开上下文处理，不自动重放。

协议5 stdout bytes 承载 UTF-8 JSONL，可跨 Output 分片；消费端先拼接完整行。每业务行最多512KiB，每行 `format_version:1`，白名单类型为 thread.started、turn.started、item.started/updated/completed、turn.completed。线程事件保留规范UUID；条目id替换为本调用内稳定的`item_1`、`item_2`等别名，保留白名单type、可选status（in_progress/completed/failed）与agent_message/reasoning的可选text。item.updated是同条目完整正文快照，完成的agent_message必须有正文；其他条目仅公开类别和状态。不转发提供者原条目id、命令、工具输出、失败详情、未知字段或stderr。未知提供者事件忽略；失败事件导致有限错误，成功终态不能被晚到事件覆盖。

正文中的部署环境值逐项脱敏，完整JSON行检查覆盖跨工具分片的敏感值；从不公开配置、凭据或原诊断。输出是供调用者直接消费的业务数据，不写入普通服务器日志。状态/完成事件不携带原始工具事件。`turn.completed`只是提供者完成观测；公开 Finished 成功还要求完整有序事件、有效回答、直接工具零退出及持久会话原子提交。最终结果只保留项目、线程、回答、十进制轮次、流格式版本及 `resource_scope:direct_process`，不返回原始 events。

## 职责、限额与资源

插件私有入口以五秒、512KiB有界首帧分派协议4/5并保留预读字节；后续严格解析与控制仍由公开运行库完成。原任务与会话清单分别声明，不给 SDK 添加 AI 字段。

`stream/events` 只做有界 JSONL、事件状态和白名单；`stream/state` 只复用 Lease 的持久归属/轮次；`stream/process` 只组装固定 CLI argv、原上下文及有界工具流。文件锁保留到直接进程与管道实际返回；Future 丢弃不释放背景资源归属，不等于已清理。

提供者 stdout累计4MiB、stderr1MiB、单行64KiB、事件最多10000；回答最多512KiB，协议输出沿公开分片与累计上限。同步文件/锁/提交放入每进程一个受限 worker，使用原绝对截止点和只读取消；最早可知失败后只等一次固定两秒清理点，超窗、panic或丢弃保留未确认。工具清理复用公共执行器，不另开业务预算，不把派生进程或远端活动算入直接资源确认。

新线程收到有效 thread.started 后先登记 uncertain、零轮次，失败仍可查询和关闭；已登记线程启动前先写 uncertain。只有完整成功与原子提交才计轮次。未知 UUID、跨项目、目录变化、closed、uncertain 和同线程并发均不能绕过既有锁或恢复规则。

## 验收与剩余范围

首帧分派、行分片/UTF-8/上限、事件顺序、白名单与敏感值、半轮取消、进程退出、持久锁、unknown/closed/uncertain 和协议4兼容分别回归。主代理协调 Cargo、格式、Clippy、宿主接线与阶段门禁，测试角色独立消费冻结版；库测试、模拟CLI、HTTP/MCP、浏览器、正式包/npx及实际模型分别记证据。

本批只计 CLI 实时业务。真实 SDK、SDK运行环境准备、旧助手工具及产品界面继续独立迁移；不能用本批 CLI 或合成模型事件替代它们。

## 本批冻结交接

21个所属文件已实现并冻结，新增22项库内回归：事件规则8项、协议4/5首帧分派3项、公开会话/真实Node管道与线程场景8项、阻塞worker物理返回/丢弃2项、新线程uncertain零轮次1项。真实Node回归代码尚未执行，不把测试设计当作通过。

已实际执行Node夹具语法检查、公开清单JSON解析（原五任务、一会话）、21文件严格UTF-8和所属`git diff --check`，均退出0。Windows换行提示保留；未运行本批Cargo、格式、Clippy、宿主服务、前端、正式包/npx或实际模型。主代理接收后统一定点格式/库测试/Clippy/构建，测试角色独立准备服务驱动，研发继续下一不冲突业务。

## 主代理定点集成

首次库编译失败原件为`artifacts/ai-streaming-integrated-lib-20261012.txt`：提示词写入错误为借用文本而循环错误要求String；worker测试错误调用运行库私有from_start。主代理只将有限错误转换为拥有的文本，并改测试通过公开协议4握手获得InvocationContext，未扩大公共库构造权限或修改业务期限。

所属Rust定点格式化后，修后库33/33通过，包括真实Node管道、PID、取消、EOF、线程持久与物理worker回归；原件`artifacts/ai-streaming-compile-fixed-lib-20261012.txt`。全目标Clippy与debug宿主/AI构建退出0，分别为`artifacts/ai-streaming-targeted-clippy-20261012.txt`、`artifacts/ai-streaming-debug-build-20261012.txt`。测试角色正在独立冻结实际程序并准备HTTP/MCP链路；这些库结果不表示服务、浏览器、正式包/npx、SDK或真实模型完成。

## 真实宿主与前端公开工厂结果

首轮独立debug报告`artifacts/ai-streaming-service-debug-dc45434c-383d-4652-a505-501d1298e122/report.json`passed，命令退出0：19检查、14会话、6持久管理Job、9受控Node工具，1482日志/354响应ID。覆盖HTTP/MCP、额外Input拒绝、EOF不取消、分页增量、提供者turn.completed时会话仍运行、两轮线程、失败uncertain、取消锁、卸载/重载与历史。34输入和冻结成员前后稳定，宿主正常关闭。

第二轮实际导入前端公开工厂，报告`artifacts/ai-streaming-service-debug-8add815c-4c38-4a93-9258-6d221cc02560/report.json`passed，命令退出0：4检查、1会话、1工具，7增量合成10个黄金事件/11块，同ID游标11、新工厂从0恢复，只有一次Open且不重放提示词。55输入含20个前端源码成员前后稳定，218日志/65响应ID。两轮10个工具均由Windows OS句柄确认自身及父插件退出，父插件exit0。

前端18项定点与新阶段440项正确串行、严格检查/build通过；阶段快照对Frida使用旧已验原件，来源逐项记录。以上仍为合成CLI和本机实际服务证据，release、正式分发、SDK、真实模型与跨平台分别待验。
