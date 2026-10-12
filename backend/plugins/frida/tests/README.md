# Frida 业务进程测试

测试入口为 `protocol.rs`，通过实际 Cargo 插件二进制和协议 4 的 Request、Ready、Start、Cancel、嵌套合作响应完成验证。写集仅限本目录，不修改 Frida 生产源码、依赖或根脚本。

`fixtures/tool.rs` 是独立标准库工具进程。主代理运行测试时，经 PATH 中的 `rustc` 一次编译，并为每个场景复制到独立目录。夹具记录真实 argv、PID、stdin、授权副本、工作目录及三个明确设置的临时目录；敏感环境仅记录合成测试标记是否被继承，不保存任意环境值。每次调用以文件门闩控制退出，无派生进程。三十秒看门狗只是失败兜底，不能作为业务期限通过的证据。

源码共 21 组测试：正常业务 5 组、输入及失败拒绝 8 组、生命周期及所有权 8 组。循环子场景包含摘要和授权字段不匹配、CLI 失败和通知损坏、零 PID 和状态标记错误、空字节和非法 UTF-8、缺少 CLEAN 和身份校验失败。

覆盖六项公开业务：server 部署、观察状态、本次 server 启停、进程枚举、授权脚本 spawn/attach、权限脚本生成及初始化诊断。核对固定 argv、授权副本、CLI 向上取整超时、产物文件名和内容、现存用户文件保留、失败输出回收、真实直接 CLI 的取消与期限退出，以及无关实际 PID 保持存活。

远端 server 测试只检验实际发给假 ADB 的脚本及响应边界：本次随机目录、server/watch/timer 三份身份、start ticks 和 executable 校验、限定 PID 的终止、CLEAN 确认、失败时保留私有证据。它们没有在 Android 上执行远端 shell，不证明真实 root、设备进程身份、厂商 Hook、Frida CLI 版本匹配或目标应用恢复已经验收。权限测试检验生成脚本与返回初始化统计，未在真实 Java 环境执行 Hook。

管道写入每帧后刷新，stderr 并发读取。输入流保持开放供取消使用，收到完整响应后关闭 stdin，再等待插件真正退出；Ready 和响应等待失败包含进程状态与非敏感 stderr 诊断。每项响应核对协议版本、请求标识与完整尾部，禁止额外 stdout。

编写及静态交接阶段未运行 Cargo、rustc、fmt、服务或设备。主代理在本目录冻结后统一执行：

```powershell
cargo fmt --all -- --check
cargo test -p deviceforge-frida-plugin --test protocol
```

测试源码完成及静态检查通过不等于上述动态测试已通过；动态结果由主代理实跑后记录。
