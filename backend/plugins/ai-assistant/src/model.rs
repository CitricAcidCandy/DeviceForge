//! 单次请求的提示词通过标准输入发送，线程标识严格校验。
use serde::Deserialize;
use serde_json::Value;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Turn {
    pub project_id: String,
    pub prompt: String,
    #[serde(default)]
    pub thread_id: Option<String>,
}
pub(crate) fn valid_thread(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}
pub(crate) fn parse(value: Value) -> Result<Turn, String> {
    if value.get("thread_id").is_some_and(|id| !id.is_string()) {
        return Err("AI助手线程标识须为字符串".into());
    }
    let turn: Turn = serde_json::from_value(value).map_err(|_| "AI助手请求无效")?;
    if turn.project_id.is_empty()
        || turn.project_id.len() > 80
        || !turn
            .project_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        || turn.prompt.trim().is_empty()
        || turn.prompt.chars().count() > 131072
    {
        return Err("AI助手项目或提示词无效".into());
    }
    if turn
        .thread_id
        .as_deref()
        .is_some_and(|id| !valid_thread(id))
    {
        return Err("AI助手线程标识无效".into());
    }
    Ok(turn)
}
pub(crate) fn response(bytes: &[u8]) -> Result<Value, String> {
    let raw = std::str::from_utf8(bytes).map_err(|_| "AI助手输出不是UTF-8")?;
    let mut events = Vec::new();
    let mut text = String::new();
    let mut thread = None;
    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        let value: Value = serde_json::from_str(line).map_err(|_| "AI助手未返回JSON事件")?;
        if value.get("type").and_then(Value::as_str) == Some("thread.started") {
            let id = value
                .get("thread_id")
                .and_then(Value::as_str)
                .filter(|id| valid_thread(id))
                .ok_or("AI助手线程开始事件缺少有效标识")?
                .to_ascii_lowercase();
            if thread.as_ref().is_some_and(|previous| previous != &id) {
                return Err("AI助手输出包含不同线程的事件".into());
            }
            thread = Some(id);
        }
        if value.get("type").and_then(Value::as_str) == Some("item.completed")
            && let Some(item) = value.get("item")
            && item.get("type").and_then(Value::as_str) == Some("agent_message")
            && let Some(message) = item.get("text").and_then(Value::as_str)
        {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(message);
        }
        if value.get("type").and_then(Value::as_str) == Some("turn.failed")
            || value.get("type").and_then(Value::as_str) == Some("error")
        {
            return Err("AI助手执行返回失败事件".into());
        }
        if events.len() >= 10000 {
            return Err("AI助手事件数量超限".into());
        }
        events.push(value);
    }
    if text.is_empty()
        || !events
            .iter()
            .any(|event| event.get("type").and_then(Value::as_str) == Some("turn.completed"))
    {
        return Err("AI助手缺少完成事件或回答".into());
    }
    Ok(serde_json::json!({"text":text,"thread_id":thread,"events":events}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retains_thread_and_rejects_partial_or_failed_turn() {
        let bytes=b"{\"type\":\"thread.started\",\"thread_id\":\"12345678-1234-1234-1234-123456789abc\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"ok\"}}\n{\"type\":\"turn.completed\"}\n";
        assert_eq!(response(bytes).unwrap()["text"], "ok");
        assert!(response(b"{\"type\":\"turn.failed\"}\n").is_err());
        assert!(response(b"{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"partial\"}}\n").is_err());
    }

    #[test]
    fn null_or_conflicting_thread_events_never_become_a_completed_turn() {
        assert!(
            parse(serde_json::json!({"project_id":"demo","prompt":"ok","thread_id":null})).is_err()
        );
        let tail = "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"ok\"}}\n{\"type\":\"turn.completed\"}\n";
        for first in [
            "{\"type\":\"thread.started\",\"thread_id\":null}\n",
            "{\"type\":\"thread.started\",\"thread_id\":\"invalid\"}\n",
            "{\"type\":\"thread.started\",\"thread_id\":\"12345678-1234-1234-1234-123456789abc\"}\n{\"type\":\"thread.started\",\"thread_id\":\"87654321-1234-1234-1234-123456789abc\"}\n",
        ] {
            assert!(response(format!("{first}{tail}").as_bytes()).is_err());
        }
    }

    #[test]
    fn single_manifest_only_declares_new_turn_input_and_prompt_counts_characters() {
        let manifest: Value = serde_json::from_str(include_str!("../manifest.json")).unwrap();
        let operations = manifest["operations"].as_array().unwrap();
        let single = operations
            .iter()
            .find(|operation| operation["name"] == "cli.single")
            .unwrap();
        let turn = operations
            .iter()
            .find(|operation| operation["name"] == "cli.turn")
            .unwrap();
        assert!(
            single["input_schema"]["properties"]
                .get("thread_id")
                .is_none()
        );
        assert!(
            turn["input_schema"]["properties"]
                .get("thread_id")
                .is_some()
        );
        assert!(
            parse(serde_json::json!({"project_id":"demo","prompt":"中".repeat(131072)})).is_ok()
        );
        assert!(
            parse(serde_json::json!({"project_id":"demo","prompt":"中".repeat(131073)})).is_err()
        );
    }
}
