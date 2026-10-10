# Harmony 独立协议业务验收

本组由测试助手独立编写，仅通过手写协议4 Request、Ready、Start、Cancel与假HDC真实子进程观察业务，不引用生产解析器、内部函数或期望生成器。当前39项 Windows测试（其它系统38项），未执行Cargo、rustc或格式化，不能记录为通过。

## 主代理执行

在backend目录、生产插件冻结并纳入workspace后执行：

```powershell
cargo test -p deviceforge-harmony-device-plugin --test protocol
```

测试首次运行会以rustc编译本目录std-only假HDC，保留每场景Temp目录、请求与响应原帧、真实插件退出码、stderr、工具argv、PID和安装字节。每个场景独占工具、配置、scratch和原件，成功或失败均保留。失败兜底杀进程有明确标记，不计成功清理证据。

## 当前覆盖

- 发现固定list targets、空结果与精确[Empty]哨兵、三项online可用性，原标识顺序，重复/非法/诊断/控制字符/128条和200字节边界整份失败。
- 应用列表固定argv与完整去首尾空白文本，卸载保留合法failed包名并使用固定参数，工具环境不继承本次注入的宿主入口和令牌变量。
- 严格四短贡献、设备封套、UUID/点分ASCII包名、配置未知及重复字段、缺依赖、非法HDC入口、显式缺配置和配置限额。
- HAP唯一授权pointer与ID、显示名、64MiB与大小/摘要资格，绝对普通源及字面父段拒绝；私有input.hap核实际原字节、源后改不影响副本、输出私有路径遮蔽及完成后实际删除。
- HDC零退出与大小写无关的独立成功行后缀，两流失败优先、非UTF8、非零退出和单流限额；取消/EOF、零预算、延迟Start及原截止点清理。
- Windows真实打开文件禁止删除时cleanup=failed、结果不发布、私有目录保留，句柄释放后无后台删除。

## 证据边界

本组不能证明HTTP/MCP、宿主共享设备锁、热装卸/旧代隔离、正式包/npx、共享HDC daemon、派生进程树、设备事务回滚、性能或真机。Future丢弃、worker panic和清理点竞争由生产内部确定性测试另验，不能从本组公开进程观察扩大结论。Android先前通过轮次属于其它插件，不计Harmony验证。
