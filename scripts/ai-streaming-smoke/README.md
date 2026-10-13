# AI 实时 CLI 公开会话独立验收

入口为 `node scripts/ai-streaming-smoke.mjs`；`--release` 使用 release，`--frozen-input=绝对目录` 可指定已经冻结的宿主、AI插件与 `manifest.json`。驱动不构建程序。主代理完成共享构建后，驱动先复制实际程序、清单、Node夹具和Windows进程探针到独占报告目录，只运行该副本。

`--frontend-only` 仅运行前端公开工厂消费的一轮，避免重新执行已经通过的完整HTTP/MCP矩阵。Node 24直接加载实际TypeScript的 `createApiClient` 与 `createHttpAiStreaming`，不替换工厂或生成业务实现。读取同一真实服务的目录/Open/增量/Finished与已结束会话历史，独立黄金事件继续校验全部原字节与结果。

## 独立判定

- 原协议4五任务和新增协议5 `plugin.ai-assistant.cli.stream` 动态发现，HTTP/MCP读取同一定义、会话及输出。
- 提示词只经Open发送一次、工具stdin结束；HTTP/MCP EOF不取消轮次。追加Input虽获传输准入，业务必须拒绝并等真实工具退出。
- 独立手写黄金事件核对UTF-8 JSONL、中文/emoji跨工具写边界、8192字节公开分块与单块分页、完整updated快照、稳定条目别名、未知事件忽略及正文脱敏。
- 真实OS等待句柄核对直接Node工具与父AI插件。提供者turn.completed之后保持工具存活，公共会话仍running、持久uncertain且轮次未增加；工具零退出和原子提交后才接受Finished成功。
- 下一轮重新Open，同thread_id不同session_id，UUID归一和轮次1→2；部分完成、非零7和晚到事件均不能提交成功。
- 未知、跨项目、closed和uncertain拒绝且无额外工具；同线程并发只证明锁等待后失败不能重放，不把等待解释为即时拒绝。
- 显式取消、卸载、重载新代、旧会话及输出留存、宿主关闭与监听释放；普通日志保存响应和后台关联，禁止正文、原条目ID、命令、工具输出、stderr及部署环境值。

## 证据与边界

每轮结果位于 `artifacts/ai-streaming-service-{profile}-{UUID}/report.json`，保留实际快照、项目计划、提示词字节、规范输出、OS探针就绪/退出原件、宿主stdout/stderr及JSONL日志。报告记录驱动静态导入、AI源码、宿主/插件/Node/探针、实际夹具和配置身份，首失败阶段不覆盖。

合成CLI事件只验真实宿主和插件链路，不证明真实模型、SDK环境、旧助手工具、浏览器、正式TGZ/npx、真机、派生树、远端活动或性能。宿主关闭后服务不能查询，关闭用例依真实进程退出和会话结束日志补证，不伪造HTTP Finished结果。

尚未运行时只报告驱动实现与语法/合同结果；真实服务证据必须引用本轮原件，不能借用后端库或终端插件验收结果。

## 2026-10-12 实际debug证据

- 完整HTTP/MCP矩阵：`artifacts/ai-streaming-service-debug-dc45434c-383d-4652-a505-501d1298e122/report.json`，实际Node退出0、19检查、14会话、6持久线程管理Job、9工具；34输入前后稳定，1482日志/354响应关联ID，宿主正常exit0并释放监听。
- 前端公开工厂定点：`artifacts/ai-streaming-service-debug-8add815c-4c38-4a93-9258-6d221cc02560/report.json`，实际Node退出0、4检查、1会话、1工具；55输入及其中20个前端feature/shared API输入前后稳定，218日志/65响应关联ID。完整消费11输出块，保留7项增量到10黄金事件；同ID保持游标11，新工厂从0恢复历史，只有1次Open且无重放，宿主正常exit0并释放监听。
- 两轮实际宿主SHA256均为 `2c23ca068a0d03d53c7f86dc3a890e45a1c5451099ec2cb26aa3c85bbeb699a8`，AI插件均为 `3e796ab20225562e8d909f036f039a6a7533a14bd687745d3866529bef890a5e`。十个受观测工具均通过真实Windows句柄确认自身和父插件退出，父插件exit0；非零提供者实际OS exit7单独保留。
- 首失败原件保留：`b6c3045c` 的预算来源字段遗漏、`83fbf8e9`/`c5ec27bf` 的根ESM作用域影响无后缀exec夹具、`e9b18de6` 的协议4Job结果包装遗漏；均为驱动错误。修后没有放宽业务、清理或黄金事件判定，没有修改生产代码。
- 最终8运行文件语法、独立10事件/双协议清单合同、实际TypeScript公开工厂加载和所属差异检查通过。完整矩阵证明其当时34输入版本，前端定点证明新增驱动/真实20前端源版本；不把两轮合称修改后完整矩阵复跑。

完整workspace门禁、release、真实浏览器、正式包/npx及真实模型保持独立待验，由主代理安排阶段队列。
