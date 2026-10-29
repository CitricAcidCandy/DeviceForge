//! 所有桥接 DTO 均从同一组 Rust 契约导出，前端不能另外维护手写传输类型。
use apk_application::debugger::*;
use serde_json::{Value, json};

pub(crate) fn contribute(document: &mut Value) {
    use crate::openapi::{endpoint, schema, v2_endpoint};
    for (name, value) in [
        ("DebuggerToolCall", schema::<super::ToolCall>()),
        ("DebuggerTarget", schema::<DebugTarget>()),
        ("DebuggerSession", schema::<DebugSession>()),
        ("DebuggerBridgePlugin", schema::<BridgePlugin>()),
        ("DebuggerBridgeRegistration", schema::<BridgeRegistration>()),
        ("DebuggerBridgeHeartbeat", schema::<BridgeHeartbeat>()),
        ("DebuggerBrowserInstance", schema::<BrowserInstance>()),
        ("DebuggerBridgeStatus", schema::<BridgeStatus>()),
        ("DebuggerBridgePoll", schema::<BridgePoll>()),
        ("DebuggerBridgeBatch", schema::<BridgeBatch>()),
        ("DebuggerBridgeAck", schema::<BridgeAck>()),
        ("DebuggerCommandResult", schema::<DebugCommandResult>()),
        ("DebuggerCommandReceipt", schema::<DebugCommandReceipt>()),
        ("DebuggerActivityQuery", schema::<ActivityQuery>()),
        ("DebuggerActivityPage", schema::<ActivityPage>()),
        ("DebuggerDataCatalogInput", schema::<DataCatalogInput>()),
        ("DebuggerDataReadInput", schema::<DataReadInput>()),
        ("DebuggerDataWriteInput", schema::<DataWriteInput>()),
        ("DebuggerAutomationInput", schema::<AutomationInput>()),
        ("DebuggerEventQuery", schema::<EventQuery>()),
        ("DebuggerEventPage", schema::<EventPage>()),
    ] {
        document["components"]["schemas"][name] = value;
    }
    let mut route = |path: &str, description: &str, input: Value, output: Value| {
        let mut value = v2_endpoint(endpoint(description, "200", output));
        value["requestBody"] =
            json!({"required":true,"content":{"application/json":{"schema":input}}});
        document["paths"][path] = json!({"post":value});
    };
    route(
        "/api/v2/debugger/call",
        "调用本机调试工具，与 MCP 共用会话与用例",
        schema::<super::ToolCall>(),
        json!({}),
    );
    route(
        "/api/v2/debugger/bridge/register",
        "登记当前浏览器实例与轻量插件目录",
        schema::<BridgeRegistration>(),
        schema::<BrowserInstance>(),
    );
    route(
        "/api/v2/debugger/bridge/heartbeat",
        "更新实例并查询是否存在明确调试会话",
        schema::<BridgeHeartbeat>(),
        schema::<BridgeStatus>(),
    );
    route(
        "/api/v2/debugger/bridge/poll",
        "仅为活动调试会话领取一次性命令",
        schema::<BridgePoll>(),
        schema::<BridgeBatch>(),
    );
    route(
        "/api/v2/debugger/bridge/ack",
        "提交绑定实例、插件与代次的结果，不重放动作",
        schema::<BridgeAck>(),
        schema::<DebugCommandReceipt>(),
    );
    route(
        "/api/v2/debugger/bridge/disconnect",
        "撤销浏览器实例与对应等待",
        schema::<super::InstanceRequest>(),
        json!({"type":"object","required":["disconnected"],"properties":{"disconnected":{"type":"boolean"}}}),
    );
    document["paths"]["/api/v2/debugger/capabilities"] =
        json!({"get":v2_endpoint(endpoint("读取本机调试器协议与实现范围", "200", json!({})))});
}
