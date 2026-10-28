# 服务器组件

Node.js 22.18 及以上，无 npm 依赖、无 SDK。入口 `entry.mjs` 从 stdin EOF 读取一个 UTF-8 JSON 请求，最多 64 KiB、等待最多 3 秒；stdout 只输出一条 JSON 响应。身份无效或解析失败时 stderr 只写固定中文诊断并非零退出；已识别请求的业务输入错误返回同请求 ID 的 `error`，零退出。

协议 1 一次调用一个进程，只声明 `echo` 普通操作；公开操作 ID 为 `plugin.demo_debugger_server.echo`。不提供反向服务调用、设备能力、外部工具、文件或网络访问，也不将协议 1 冒充合作取消或会话协议。宿主部署环境须已有可发现的 Node 运行时；本包不下载运行时。

在本目录执行 PowerShell：

```powershell
'{"protocol_version":1,"request_id":"demo-1","operation":"echo","input":{"message":"你好"}}' | node ./entry.mjs
```

预期响应：

```json
{"protocol_version":1,"request_id":"demo-1","result":{"message":"你好","source":"demo_debugger_server"}}
```

`message` 是唯一输入字段，最多 1000 个 Unicode 字符；空字符串合法。协议请求使用短操作名 `echo`，宿主普通任务提交使用完整操作 ID，两者不能混用。

在本目录执行 `npm pack --ignore-scripts` 可独立打 TGZ；也可使用随完整示例提供的自有 ZIP 打包器。便携清单不指定本机可执行路径，由兼容宿主安装器选择 Node 入口。独立协议运行不证明宿主安装或 Debugger 联调已通过。
