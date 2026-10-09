# 合作取消示例插件

独立 Rust 进程通过公开 deviceforge-plugin-runtime 接入协议 3，贡献 plugin.cooperative_demo.wait。输入 duration_ms 为 1–3600000；取消通知到达后执行模拟 40 ms 清理，再确认 complete。返回 synthetic_demo，不访问真实设备或 Frida。

构建 `cargo build -p deviceforge-cooperative-demo-plugin`，填 manifest.example.json 的绝对入口并按插件 ID 部署。可运行中加载/卸载；失败清理不会被算成成功卸载。

测试部署可通过 argv 第一项指定受控标记目录，写 started/cleaned；第二项 ignore 或 failed 仅用于验证未合作与清理失败。业务请求不得指定服务器路径。args 由管理员清单提供；测试标记不属于公开响应。

执行 `cargo test -p deviceforge-cooperative-demo-plugin` 验证真实进程的成功、取消、EOF、Future 丢弃与卸载排空。npx 便携原生包由根 pack:plugins 派生；合作协议不等于 Frida 已完成迁移。
