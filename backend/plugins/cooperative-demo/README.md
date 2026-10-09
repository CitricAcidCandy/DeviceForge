# 合作取消示例插件

独立 Rust 进程通过公开 deviceforge-plugin-runtime 接入协议 3，贡献 plugin.cooperative_demo.wait。输入 duration_ms 为 1–3600000；取消通知到达后执行模拟 40 ms 清理，再确认 complete。返回 synthetic_demo，不访问真实设备或 Frida。

构建 `cargo build -p deviceforge-cooperative-demo-plugin`，填 manifest.example.json 的绝对入口并按插件 ID 部署。可运行中加载/卸载；失败清理不会被算成成功卸载。

测试部署可通过 argv 第一项指定受控标记目录，写 started/cleaned；第二项 ignore 或 failed 仅用于验证未合作与清理失败。业务请求不得指定服务器路径。args 由管理员清单提供；测试标记不属于公开响应。

合作取消时先写 `cancel_received`，再等待模拟资源释放并写 `cleaned`；测试同时检查任务终态与本次子进程退出。`artifact` 模式在宿主授权的输出目录生成 JSON 产物，验证协议 3 保留协议 2 的 `{result, artifacts}` 包装和发布能力。

`src/fixtures.rs` 只提供管理员 argv 选择的进程故障夹具：EOF、非零退出、错误关联 ID、错误版本、互斥响应字段冲突、旧版未包装响应和两路输出超限。超限夹具输出后保持存活，用于验证宿主确实终止并等待当前子进程；没有真实设备副作用。

`partial_response` 在取消前后分段写出同一响应，验证宿主保留已经读取的数据并拒绝晚到成功；`nonzero_response` 声明 complete 后仍非零退出，宿主必须保留未确认清理标记。

`sdk_stdin_eof` 使用真实公开 SDK 输出清理响应后，明确等宿主关闭 stdin 才零退出，并写 `response_written/stdin_eof` 标记。该回归证明取消宽限阶段也处理完整响应通知，避免宿主等退出、插件等 EOF 的互相等待；合作期限仍为 1250 ms。

`tests/protocol.rs` 使用 Cargo 实际构建的插件入口。生命周期回归通过真实 SQLite、文件产物和固定部署目录端口装配 Application/PluginService，验证运行任务卸载后的 owner 删除，及未合作/清理失败时保留 draining、再次卸载仍失败，并拒绝重载和提交。

执行 `cargo test -p deviceforge-cooperative-demo-plugin` 验证真实进程的成功、取消、EOF、Future 丢弃与卸载排空。npx 便携原生包由根 pack:plugins 派生；合作协议不等于 Frida 已完成迁移。
