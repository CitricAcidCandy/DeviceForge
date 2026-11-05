//! UI 工具的 MCP 封套检查；业务参数一律调用用例层的同一契约，不在边界复制动作规则。

use super::{ApiError, CommandInput};
use apk_application::debugger::{DebugTool, ui_contract::{self, UiValidationDetails}};
use axum::http::StatusCode;
use serde_json::{Value, json};

pub(super) fn tool(name: &str) -> Option<DebugTool> {
    match name {
        "deviceforge.debug_ui_tree" => Some(DebugTool::UiTree),
        "deviceforge.debug_ui_query" => Some(DebugTool::UiQuery),
        "deviceforge.debug_ui_diff" => Some(DebugTool::UiDiff),
        "deviceforge.debug_ui_assert" => Some(DebugTool::UiAssert),
        "deviceforge.debug_ui_action" => Some(DebugTool::UiAction),
        _ => None,
    }
}

fn invalid(tool: DebugTool, path: &str, expected: &str) -> ApiError {
    let details = UiValidationDetails {
        path: path.into(),
        expected: expected.into(),
        example: json!({"session_id":"当前会话标识","parameters":ui_contract::example(tool)}),
    };
    ApiError::new(StatusCode::BAD_REQUEST, "debugger_invalid_input", format!(
        "调试参数不符合当前工具模式，请核对字段层级；details={}",
        serde_json::to_string(&details).unwrap_or_else(|_| "{}".into())
    ))
}

pub(super) fn decode(tool: DebugTool, input: Value) -> Result<CommandInput, ApiError> {
    let fields = input.as_object().ok_or_else(|| invalid(tool, "input", "输入必须是包含 session_id 和 parameters 的对象"))?;
    if fields.keys().any(|key| key != "session_id" && key != "parameters") {
        return Err(invalid(tool, "input", "顶层仅接收 session_id 和 parameters；action、root_id、expect 放入 parameters"));
    }
    if !fields.get("session_id").is_some_and(Value::is_string) {
        return Err(invalid(tool, "session_id", "必须提供字符串类型的当前调试会话标识"));
    }
    let parameters = fields.get("parameters").cloned().unwrap_or_else(|| json!({}));
    if !parameters.is_object() {
        return Err(invalid(tool, "parameters", "工具参数必须是对象"));
    }
    apk_application::debugger::validate_debug_command(tool, &parameters).map_err(super::error)?;
    super::decode(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debugger_ui_envelope_reports_layer_without_echoing_input() {
        let result = decode(DebugTool::UiAction, json!({
            "session_id":"session", "action":{"value":"不得回显的输入"},
            "unknown-private-field":"不得回显的字段内容"
        }));
        let failure = result.err().expect("错层级应在派发之前失败");
        assert_eq!(failure.1.code, "debugger_invalid_input");
        assert!(failure.1.message.contains("details="));
        assert!(failure.1.message.contains("parameters"));
        assert!(!failure.1.message.contains("不得回显"));
        assert!(!failure.1.message.contains("unknown-private-field"));
    }

    #[test]
    fn debugger_ui_envelope_rejects_missing_fill_value_with_exact_field() {
        let failure = decode(DebugTool::UiAction, json!({"session_id":"session","parameters":{
            "action":{"type":"fill","target":{"id":"n1","generation":1,"revision":1},"confirmed":true}
        }})).err().expect("缺失填写值应在派发之前失败");
        assert_eq!(failure.1.code, "debugger_invalid_input");
        assert!(failure.1.message.contains("parameters.action.value"));
    }
}
