# 服务器插件完整示例

## 推荐的单清单入口

新工程使用 manifest 主题的 manifest.json（manifest_version:1）；将下面 entry.mjs 保存到对应组件 root，files 只列 entry.mjs，plugin.operations 使用下面回显操作。package.json、plugin.json、market.json 和 release.json 均由 `deviceforge plugin pack` 生成，不再手写。顶层 market 支持完整展示资料，字段、默认值和枚举均在 manifest 主题直接提供。

下面旧协议示例的独立回显处理器仍可复用；其手写清单只用于旧包兼容与理解协议，不表示新开发仍需维护多份声明。

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

## Rust 协议 4 处理器示意（可选 SDK）

以下只展示公共运行库的处理器 API，不是可直接构建的完整 Cargo 包。选择 Rust SDK 时，先取得与目标宿主协议兼容、可独立消费的 SDK 开发包，再在自己的插件工程声明 `apk-plugin-sdk`、`deviceforge-plugin-runtime`、`serde_json` 和 Tokio 依赖；不假设官方 crate 已发布，不要求宿主仓库或其目录结构。未取得开发包时，先使用上面的完整 Node.js 示例。此处理器无外部资源；实际工具、连接和设备资源须补齐清理实现后才可声明完成。

### 处理器与入口

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

依赖准备完成后，在自己的插件工程使用 `cargo build`，无需编译宿主。其包清单可复用 Node 示例的操作模式，替换插件 ID，设置 `protocol_version=4`，以 `runtime=native` 指向预编译文件。`Ready/Start` 与取消控制由运行库处理，不能把普通协议 1 的一次性 stdin 命令当成协议 4 集成验证。

需要等待、工具或连接时，使用 `context.deadline()` 和 `context.cancellation()` 传递同一预算及取消信号；取消后先等待实际工作与清理结束，再返回 `Execution`。任何清理失败都返回明确的 `CleanupOutcome::Failed`，不能复用本例的 `complete` 掩盖资源未释放。

## 将示例组成一个完整功能

Node 示例仍是独立 `kind:"server"` 的底层组件。与前端 examples 中 `browser_guide_example@0.1.0` 配套时，外层功能可命名 `guide-suite@1.0.0`，目录如下：

```text
guide-suite/
  release.json
  blobs/
    <服务器TGZ的SHA-256>
    <浏览器TGZ的SHA-256>
```

`release.json` 的结构如下；尖括号必须由发布器以真实摘要和整数大小替换，本段是结构模板，不能直接安装：

```json
{
  "format_version": 1, "host_api_version": 2,
  "id": "guide-suite", "version": "1.0.0",
  "name": "指南配套功能", "description": "服务器回显与浏览器任务面板",
  "components": [
    {"id": "guide_echo", "kind": "server", "version": "1.0.0",
     "variants": [{"platform": "any", "path": "blobs/<服务器SHA-256>",
       "sha256": "<服务器SHA-256>", "size": 1, "format": "tgz"}]},
    {"id": "browser_guide_example", "kind": "browser", "version": "0.1.0",
     "variants": [{"platform": "any", "path": "blobs/<浏览器SHA-256>",
       "sha256": "<浏览器SHA-256>", "size": 1, "format": "tgz"}]}
  ],
  "tools": [], "requirements": []
}
```

本例不执行外部工具，因此 tools 为空；需要工具时按 manifest 主题增加真实归档、entries 和 bindings，不把本机程序塞进组件业务参数。将目录内容打为 ZIP 时，根必须直接包含 release.json 和 blobs/，不要多套 guide-suite 目录；在线发布改为同服务摘要 path 后重算清单 SHA-256，遵守 packaging 中能力探测和 catalog 最后提交。

安装该成套发布后，使用 `deviceforge.list_plugin_installations` 或公开 HTTP 查询真实修订和状态，再核对服务器操作及浏览器实例；不再把两个组件分别安装/加载当成完整功能验收。配置和高级路径覆盖仍保留用户原值，SDK 托管资源入口见 sdk 主题。

## 独立服务插件

提供者和消费方各自是独立插件包。以文本规范化为例：提供者声明精确引用 `example.text.normalize@1.0`、输入/输出 JSON Schema 和映射的普通操作；消费方只在需要规范化的操作声明该必需依赖，独立的 `ping` 不声明。服务版本使用字符串 `"1.0"`。清单字段查询 `manifest`，公共运行入口 `serve_once_with_services`、`ServiceHandle` 与 `ServiceClient` 查询 `sdk`，父子期限、取消和清理查询 `lifecycle`。

取得独立 SDK 开发包后，分别编译并按 `packaging` 打包两个插件，安装到部署者提供的兼容宿主，无需构建宿主。通过公开目录核对服务，再提交消费方操作并用 `deviceforge.get_job` 查询终态。服务缺失或版本不符时只影响依赖它的操作，独立 `ping` 仍可用。

在自己的测试环境核对正常组合、错误输入/输出、提供者卸载和换代、父任务取消与本次资源清理。记录实际包版本、摘要、Job、日志及终态；不能用 API 示意、编译成功或普通回显代替协议 6 调用通过。需要可直接运行且无 SDK 依赖的完整入门包时，使用本篇开头的 Node.js 协议 1 示例。
