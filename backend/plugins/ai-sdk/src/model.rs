use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROVIDER: &str = "codex_sdk";
pub const SDK_VERSION: &str = "0.162.1";
pub const NODE_VERSION: &str = "24.14.0";
pub const PROFILE: &str = "codex_sdk_ts_0_162_1_node24";
pub const PROMPT_CHAR_LIMIT: usize = 131_072;
pub const TEXT_BYTE_LIMIT: usize = 512 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TurnInput {
    pub project_id: String,
    pub prompt: String,
    #[serde(default)]
    pub thread_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThreadInput {
    pub project_id: String,
    pub thread_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssistantInput {
    pub project_id: String,
    #[serde(default)]
    pub user_prompt: Option<String>,
    #[serde(default)]
    pub stream_output: bool,
}

#[derive(Clone, Debug)]
pub enum Operation {
    Status,
    Single(TurnInput),
    Turn(TurnInput),
    Get(ThreadInput),
    Close(ThreadInput),
    Assistant(AssistantInput),
    Stream(TurnInput),
}

#[derive(Debug, Serialize)]
pub struct TurnResult {
    pub provider: &'static str,
    pub sdk_version: &'static str,
    pub project_id: String,
    pub thread_id: String,
    pub text: String,
    pub turns: String,
    pub resource_scope: &'static str,
}

pub fn valid_project(project: &str) -> bool {
    !project.is_empty()
        && project.len() <= 80
        && project
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

pub fn normalize_thread(thread: &str) -> Result<String, String> {
    if thread.len() != 36
        || !thread.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
    {
        return Err("SDK线程标识须为规范UUID".into());
    }
    Ok(thread.to_ascii_lowercase())
}

fn validate_prompt(prompt: &str) -> Result<(), String> {
    if prompt.trim().is_empty() || prompt.chars().count() > PROMPT_CHAR_LIMIT {
        return Err("SDK提示词为空或字符数超限".into());
    }
    Ok(())
}

fn turn(mut value: Value, allow_thread: bool) -> Result<TurnInput, String> {
    if value
        .get("thread_id")
        .is_some_and(|thread| !allow_thread || !thread.is_string())
    {
        return Err("SDK操作不接受该线程字段".into());
    }
    if let Some(thread) = value.get_mut("thread_id") {
        *thread = Value::String(normalize_thread(thread.as_str().ok_or("SDK线程字段无效")?)?);
    }
    let input: TurnInput = serde_json::from_value(value).map_err(|_| "SDK轮次输入无效")?;
    if !valid_project(&input.project_id) {
        return Err("SDK项目标识无效".into());
    }
    validate_prompt(&input.prompt)?;
    Ok(input)
}

fn thread(value: Value) -> Result<ThreadInput, String> {
    let mut input: ThreadInput = serde_json::from_value(value).map_err(|_| "SDK会话输入无效")?;
    if !valid_project(&input.project_id) {
        return Err("SDK项目标识无效".into());
    }
    input.thread_id = normalize_thread(&input.thread_id)?;
    Ok(input)
}

pub fn parse(operation: &str, value: Value) -> Result<Operation, String> {
    match operation {
        "runtime.status" if value.as_object().is_some_and(|fields| fields.is_empty()) => {
            Ok(Operation::Status)
        }
        "sdk.single" => turn(value, false).map(Operation::Single),
        "sdk.turn" => turn(value, true).map(Operation::Turn),
        "sdk.stream" => turn(value, true).map(Operation::Stream),
        "session.get" => thread(value).map(Operation::Get),
        "session.close" => thread(value).map(Operation::Close),
        "assistant.run" => {
            if value
                .get("user_prompt")
                .is_some_and(|prompt| !prompt.is_string())
            {
                return Err("测试助手可选提示词须为字符串".into());
            }
            let input: AssistantInput =
                serde_json::from_value(value).map_err(|_| "测试助手输入无效")?;
            if !valid_project(&input.project_id) {
                return Err("测试助手项目标识无效".into());
            }
            if let Some(prompt) = &input.user_prompt {
                validate_prompt(prompt)?;
            }
            Ok(Operation::Assistant(input))
        }
        _ => Err("SDK操作或输入不受支持".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strict_fields_and_single_owner_are_enforced() {
        for input in [
            json!({"project_id":"demo","prompt":"ok","thread_id":null}),
            json!({"project_id":"demo","prompt":"ok","path":"C:/other"}),
            json!({"project_id":"demo","prompt":"ok","thread_id":"12345678-1234-1234-1234-123456789abc"}),
        ] {
            assert!(parse("sdk.single", input).is_err());
        }
        assert!(parse("runtime.status", json!(null)).is_err());
        assert!(
            parse(
                "assistant.run",
                json!({"project_id":"demo","user_prompt":null})
            )
            .is_err()
        );
        assert!(
            parse(
                "assistant.run",
                json!({"project_id":"demo","stream_output":null})
            )
            .is_err()
        );
    }

    #[test]
    fn unicode_prompt_counts_characters_and_thread_is_canonicalized() {
        assert!(
            parse(
                "sdk.turn",
                json!({"project_id":"demo","prompt":"中".repeat(PROMPT_CHAR_LIMIT)})
            )
            .is_ok()
        );
        assert!(
            parse(
                "sdk.turn",
                json!({"project_id":"demo","prompt":"中".repeat(PROMPT_CHAR_LIMIT+1)})
            )
            .is_err()
        );
        let parsed = parse("sdk.turn", json!({"project_id":"demo","prompt":"ok","thread_id":"ABCDEF12-1234-1234-1234-123456789ABC"})).unwrap();
        let Operation::Turn(input) = parsed else {
            panic!("轮次类型错误")
        };
        assert_eq!(
            input.thread_id.as_deref(),
            Some("abcdef12-1234-1234-1234-123456789abc")
        );
    }
}
