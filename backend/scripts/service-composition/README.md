# 独立 Rust 协议 6 组合验收

入口为 `backend/scripts/service-composition-smoke.mjs`。只消费已有二进制，不运行 Cargo、npm、设备工具或 MCP 服务器；所有构建及真实执行由主代理串行安排。

## 文件职责

- `run.mjs`：唯一编排与收尾、总期限、输入摘要、进程/日志证据和报告。
- `host.mjs`：每轮独立宿主副本、随机本地端口及数据/用户根；只结束自己持有的 ChildProcess。
- `packages.mjs`：把两个真实 Rust 程序和公开示例清单封装为本轮原生 TGZ，经 HTTP 安装并核对部署入口摘要。
- `api.mjs`：HTTP/MCP 关联、原 Job/事件查询、入口拒绝和目录一致性断言，不引入第二种任务。
- `matrix.mjs`：组合、精确版本、依赖失效/恢复、模式、取消和换代验证。
- `common.mjs`：有界轮询、标记解析及进程退出观察；不按历史 PID 杀进程。

## 主代理运行命令

在 `G:\Rust\DeviceForge` 执行。两个示例有自己的 `[workspace]`，不属于后端工作区；`cargo build --workspace` 不会构建它们。以下命令共享 `backend/target`，必须串行，不能和其他 Cargo 门禁并行。

```powershell
cargo build --manifest-path backend/Cargo.toml -p apk-server --target-dir backend/target -j 1
cargo build --manifest-path examples/server-service-normalize/Cargo.toml --target-dir backend/target -j 1
cargo build --manifest-path examples/server-service-compose/Cargo.toml --target-dir backend/target -j 1
node backend/scripts/service-composition-smoke.mjs

cargo build --release --manifest-path backend/Cargo.toml -p apk-server --target-dir backend/target -j 1
cargo build --release --manifest-path examples/server-service-normalize/Cargo.toml --target-dir backend/target -j 1
cargo build --release --manifest-path examples/server-service-compose/Cargo.toml --target-dir backend/target -j 1
node backend/scripts/service-composition-smoke.mjs --release
```

也可将三份预构建文件放入同一个冻结目录，设置绝对路径 `DEVICEFORGE_SMOKE_BINARY_DIR`；默认按所选模式读取 `backend/target/debug` 或 `backend/target/release`。脚本不会自行生成示例 `bin/` 或执行 npm 打包。

## 矩阵与判定

1. 空目录启动；仅安装/加载消费者时，组合服务及操作拒绝，HTTP/MCP 的 ping 继续成功。
2. 分别在线安装两个原生 TGZ；组合服务、提供服务和普通组合操作均分别从 HTTP/MCP 提交，并读取相同 Job、唯一终态及事件；子调用不能额外创建顶层 Job。
3. 精确字符串版本不匹配、数字/空版本、输入模式错误在准入阶段拒绝，零新增 Job。
4. 提供者卸载、错误提供版本、恢复及旧代际：相关入口暂停，不封锁 ping 或错误版本提供者自身的合法入口；恢复后实际组合成功。
5. 只在本轮已卸载的部署副本上收紧输入/输出 schema：嵌套输入拒绝不得启动目标进程；输出违约必须令顶层及嵌套任务失败，不能假成功或误报清理失败。源码清单不变。
6. HTTP/MCP 各取消一次活动父任务；两个真实独立 Rust 进程必须收到取消、写入处理器结束标记并退出，旧取消不被下一笔成功覆盖。
7. 活动子调用的提供者卸载；子进程收到取消并退出，父任务不得接受旧代结果，重载后新调用成功。
8. 消费者卸载撤销自己的目录/操作而不撤销提供者。最后保留一笔父子活动调用，宿主退出时一并清理，确认宿主正常退出和端口可重新绑定。

祖先已持同提供者读屏障时，子调用若排在外部写者之后，应立即明确 `conflict`，而非重新排队自等待。收到 `Finished` 后保留完整 1250ms 清理窗口，不受业务剩余预算截短。这两个临界顺序仍由主代理的应用/协议定点回归验证，本组合脚本不能替代这些定点测试。

## 证据和失败保留

每轮写入新的 `artifacts/service-composition-smoke-<debug|release>-<runID>/`，不覆盖旧报告、不删除失败原件。保留 `report.json`、`inputs.json`、两份 TGZ、部署初始清单、宿主日志、调用标记和本轮数据根。报告保存输入/归档/真实部署入口的 SHA-256、Job、日志关联、父子 PID、退出与端口释放。源码摘要与程序摘要分别记录，不把它们自动解释为源码构建溯源证明。

每轮宿主使用从未启动过的新路径，仅请求本轮随机令牌对应服务退出；不替换用户服务。正常关闭有上限，超时只终止脚本持有的宿主 ChildProcess，并记失败。插件 PID 仅观察，不按可复用的旧 PID 代杀；仍可见或无权限确认均为未通过，保留目录交主代理处理。整体业务期限五分钟，单请求、轮询、取消及关闭另有固定上限。访问令牌只在内存与本轮宿主环境传递，不写报告。

Rust 示例的 `--smoke-directory <绝对目录>` 只由本轮管理员清单传入，不增加业务输入字段。默认无参数时不写标记；normalize 仅在显式目录存在 `hold` 文件时等待，最多六十秒并监听原调用取消。诊断文件只证明处理器到达/结束，必须同时结合宿主清理结果、直接进程退出和正常宿主退出，不能把标记当作全部资源释放证明。

本脚本不验浏览器、公开 npm 分发、真实设备、长期会话、完整派生树或性能。协议 6 沿用原任务生命周期，不新建常驻服务；现有协议 5 会话无需改成服务帧。debug/release 真实执行结果按独立 runID 登记在[插件基础设施实施验收](../../docs/verification/插件基础设施实施验收-20261027.md)，失败轮不改判。
