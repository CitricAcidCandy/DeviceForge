# 普通操作真实期限夹具

本目录只构造可信 Node 便携 TGZ 和受控进程证据，不包含宿主验收驱动。实施输入为后端《普通操作总期限第一批契约》及 Kuhn《普通操作真实长进程验收方案》（SHA256 `64fb08914e59f00a596f98f8895f827c8b739552877f42f24ea9134b94b45d9b`）。

## 已冻结调用接口

`export async function createFixtures(directory, report)` 返回两个条目的数组，每项严格提供：

```text
{ pluginId, protocolVersion: 2 | 3, archivePath, archiveSha256,
  controlRoot, operations: { long, short, default },
  shortTimeoutMs: 10000, runId }
```

`operations` 是三个完整公开操作 ID。包声明 long=120000、short=10000 毫秒；default 省略 execution。控制根以管理员生成的绝对路径嵌入可信包配置，不从公开业务参数取路径。业务 input 只能是 `{case_id}`，case*id 符合 ASCII `^[A-Za-z0-9*-]{1,80}$`。

`directory` 是验收方本次独占临时根；构造器在其下新建唯一子目录，为两协议各建控制根并保存实际 TGZ。每次调用生成一个共享 runId，两包 pluginId 不同；`archiveSha256` 是写入归档的实际压缩字节 SHA256 小写十六进制。复用 `../device-provider/fixtures.mjs` 的 `archive`，不复制 TAR 构造器。`report` 形参为接线保留，构造器不改共享报告；验收方将返回摘要并入自己的证据。

## 已冻结控制与证据文件

- `controlRoot/<case_id>.ready.json`：临时文件写完后原子 rename 发布；必填 `{run_id,case_id,plugin_id,protocol_version,pid,request_id,request_operation,ready_monotonic_ns:string}`。
- `controlRoot/<case_id>.release`：验收方写入 UTF-8 内容 `1`。long/short 保持等待，直到观察 release 或取消；default 即时返回有限结果。每个 case_id 只运行一次，避免复用旧标记。
- `controlRoot/<case_id>.events.jsonl`：每行字段 `event` 只取 `ready|cancel_received|response_written|cleaned|stdin_eof|process_exit`，带同一身份及十进制字符串 `monotonic_ns`。cancel_received 记录线上 reason 和控制 request_id 匹配；process_exit 另带 `code`。

cancel_received 的附加字段固定为 `{reason,command,control_request_id,id_matches}`，reason 只接受 `timeout|cancelled`，command 必须为 `cancel`，control_request_id 必须严格匹配 SDK Request.request_id；不把 EOF 写成取消事件。ready、事件和结果的 request_operation 均取 SDK 短操作名，公开完整操作 ID 从 `operations` 获取。

成功业务 result 固定为：

```text
{ run_id, case_id, plugin_id, protocol_version, pid, request_id,
  request_operation, ready_monotonic_ns, completed_monotonic_ns, elapsed_ms }
```

completed_monotonic_ns 取夹具观察 release 或 default 完成本次业务的时刻；elapsed_ms 从同一进程 ready 单调计数计算。不同进程的绝对计数不能相减。SDK Request 不提供 Job ID，验收方用实际 Job 和这些身份字段回映，不伪造 Job 归属。

协议 2 输出匹配的有限 Response 并正常退出；stdin EOF 是正常输入结束，不代表合作取消。协议 3 保持 stdin 读取，严格校验 cancel 的 protocol/request_id/command/reason，使用真实 CooperativeResponse `{response,cleanup}`，不用夹具私有包装。cleaned 只证明本次受控夹具文件资源已释放，不代表真机、外部事务或常驻会话清理。response_written 等待 stdout 写入回调；process_exit 事件和自有 PID 实际退出须分别核对。

## 有界诊断与验收边界

每次合法且未复用的 case 创建 `<case_id>.resource` 并持有该文件句柄；正常成功或合作取消先关闭句柄、删除自己创建的这个文件，再记录 cleaned。case_id 一次性使用，发现该案例已有任何控制或证据文件就失败，不借用旧 release。未完成的 release 写入不会放行，只有完整内容 `1` 才生效。

进程退出回调写 `<case_id>.diagnostic.json`，含上述身份、outcome、failure_code、cancel_reason、response_started、response_written、stdin_eof、controlled_resource_released、completed_monotonic_ns、exit_callback_code 和 monotonic_ns。它是有限的夹具自报诊断；不能将 outcome 或 exit_callback_code 单独当作宿主 Job 终态、OS 退出码或外部资源证明。协议 2 被强制终止时可能没有退出回调、诊断或 cleaned，残留 resource 文件保留为失败证据，不伪补合作确认。

协议 3 响应后最多等真实 stdin EOF 1000 毫秒，预响应且无合法取消的 EOF 失败。夹具自身 130000 毫秒 watchdog 只防孤儿永久 hold，晚于 long 声明；它不能代替宿主 short=10000 的到期、线上 reason=timeout 或实际 PID 退出检查。清理只操作本进程创建的单个文件，不结束其它进程，不执行包脚本。

三文件源码已落盘并冻结交接。仅核对文本、UTF-8 和文件哈希；尚未运行语法检查、构包、安装、HTTP/MCP 或真实进程验收。归档是否成功生成、宿主包装与日志/Job 关联、两协议期限及取消和实际退出均由主代理与验收驱动实测。
