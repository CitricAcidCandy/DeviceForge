# 服务器插件完整示例

## Node.js 协议 1 回显包

把以下三个文件放在同一个 `guide-echo` 目录。需要可运行的 Node.js；示例无 npm 依赖、不启动工具、不创建外部资源，适合协议 1。它是本地自建示例，没有假设官方 npm 包已经发布。

### package.json

```json
{
  "name": "deviceforge-guide-echo",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "deviceforge": {
    "kind": "server",
    "manifest": "plugin.json",
    "entrypoints": {"any": {"runtime": "node", "path": "entry.mjs"}}
  }
}
```

### plugin.json

```json
{
  "id": "guide_echo",
  "version": "1.0.0",
  "protocol_version": 1,
  "args": [],
  "operations": [{
    "name": "echo",
    "title": "指南示例回显",
    "input_schema": {
      "type": "object",
      "properties": {"message": {"type": "string", "maxLength": 1000}},
      "required": ["message"],
      "additionalProperties": false
    }
  }]
}
```

### entry.mjs

```javascript
// 标准输出仅写协议；此示例不创建需要清理的外部资源。
const LIMIT = 512 * 1024;
async function readRequest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > LIMIT) throw new Error('请求超过限额');
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (request?.protocol_version !== 1 || typeof request.request_id !== 'string'
      || request.request_id.length === 0 || request.request_id.length > 128) {
    throw new Error('协议或请求身份无效');
  }
  return request;
}
function execute(request) {
  const input = request.input;
  if (request.operation !== 'echo' || input === null || typeof input !== 'object'
      || Array.isArray(input) || Object.keys(input).length !== 1
      || typeof input.message !== 'string' || [...input.message].length > 1000) {
    throw new Error('操作或输入不符合示例契约');
  }
  return { message: input.message, source: 'guide_echo' };
}
try {
  const request = await readRequest();
  const response = { protocol_version: 1, request_id: request.request_id };
  try { response.result = execute(request); }
  catch { response.error = '操作或输入不符合示例契约'; }
  process.stdout.write(`${JSON.stringify(response)}\n`);
} catch {
  // 无法匹配请求身份时只报告固定诊断，不回显原始输入。
  process.stderr.write('指南示例请求解析失败\n');
  process.exitCode = 1;
}
```

### 独立运行

在示例目录执行 PowerShell：

```powershell
'{"protocol_version":1,"request_id":"guide-check","operation":"echo","input":{"message":"你好"}}' | node ./entry.mjs
```

应得到同版本、同请求 ID 的 `result`，其中 `message` 为 `你好`、`source` 为 `guide_echo`。此检查只证明独立协议，不证明宿主安装或任务执行。按 `packaging` 安装并加载后，公开操作是 `plugin.guide_echo.echo`。

## Rust 协议 4 最小入口

在本项目源码的 `backend/examples/guide-context` 中建立下列独立 Cargo 包。路径依赖指向当前源码中的公共库；不依赖已发布 crate，不引用宿主私有模块。它用于说明正确接入固定期限，无外部资源；实际工具、连接和设备资源须补齐清理实现后才可声明完成。

### Cargo.toml

```toml
[package]
name = "deviceforge-guide-context"
version = "1.0.0"
edition = "2024"

[workspace]

[dependencies]
apk-plugin-sdk = { path = "../../crates/plugin-sdk" }
deviceforge-plugin-runtime = { path = "../../crates/plugin-runtime" }
serde_json = "1"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

### src/main.rs

```rust
use apk_plugin_sdk::Request;
use deviceforge_plugin_runtime::{Execution, InvocationContext, serve_once_with_context};
use serde_json::json;

async fn execute(request: Request, context: InvocationContext) -> Execution {
    let outcome = (|| {
        context.check().map_err(|error| error.to_string())?;
        if request.operation != "echo" {
            return Err("未知操作".to_owned());
        }
        let message = request.input.get("message")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "缺少 message".to_owned())?;
        context.check().map_err(|error| error.to_string())?;
        Ok(json!({"message": message}).into())
    })();
    // 此示例没有外部资源，所有工作均已结束后才确认清理完成。
    Execution::complete(outcome)
}

#[tokio::main]
async fn main() -> Result<(), String> {
    serve_once_with_context(execute).await
}
```

构建使用 `cargo build --manifest-path backend/examples/guide-context/Cargo.toml`。其包清单可复用 Node 示例的操作模式，替换插件 ID，设置 `protocol_version=4`，以 `runtime=native` 指向预编译文件。`Ready/Start` 与取消控制由运行库处理，不能把普通协议 1 的一次性 stdin 命令当成协议 4 集成验证。

需要等待、工具或连接时，使用 `context.deadline()` 和 `context.cancellation()` 传递同一预算及取消信号；取消后先等待实际工作与清理结束，再返回 `Execution`。任何清理失败都返回明确的 `CleanupOutcome::Failed`，不能复用本例的 `complete` 掩盖资源未释放。
