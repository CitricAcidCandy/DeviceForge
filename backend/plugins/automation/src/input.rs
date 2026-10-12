//! Windows业务模型与纯规则，不在解析阶段调用桌面API。
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) fn text(value: &str, limit: usize) -> Result<()> {
    if value.is_empty() || value.len() > limit || value.chars().any(char::is_control) {
        return Err(Error::Invalid("文本为空、过长或包含控制字符"));
    }
    Ok(())
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Button {
    Left,
    Right,
    Middle,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Click {
    Single,
    Double,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Position {
    pub x: i32,
    pub y: i32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MouseClick {
    pub button: Button,
    pub click: Click,
    #[serde(default)]
    pub position: Option<Position>,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Repeat {
    Count { count: u32 },
    Duration { duration_ms: u64 },
    Manual { max_duration_ms: u64 },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MouseRepeat {
    pub button: Button,
    pub click: Click,
    #[serde(default)]
    pub position: Option<Position>,
    pub interval_ms: u64,
    pub repeat: Repeat,
    #[serde(default = "yes")]
    pub stop_on_f9: bool,
}
fn yes() -> bool {
    true
}
impl MouseRepeat {
    pub(crate) fn validate(&self) -> Result<()> {
        if !(10..=60000).contains(&self.interval_ms) {
            return Err(Error::Invalid("点击间隔须为10至60000毫秒"));
        }
        match self.repeat {
            Repeat::Count { count }
                if (1..=10000).contains(&count)
                    && u64::from(count - 1) * self.interval_ms <= 600000 =>
            {
                Ok(())
            }
            Repeat::Duration { duration_ms } if (100..=600000).contains(&duration_ms) => Ok(()),
            Repeat::Manual { max_duration_ms } if (100..=600000).contains(&max_duration_ms) => {
                Ok(())
            }
            _ => Err(Error::Invalid("重复次数、持续时间或手动模式硬上限无效")),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Record {
    pub event_type: u8,
    pub interval_ms: u64,
    pub duration_ms: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Playback {
    pub artifact_id: String,
    pub event_type: u8,
}
pub(crate) enum Operation {
    Android,
    Position,
    Click(MouseClick),
    Repeat(MouseRepeat),
    Record(Record),
    Playback(Playback),
}
fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T> {
    serde_json::from_value(value.clone())
        .map_err(|_| Error::Invalid("字段缺失、类型或额外字段无效"))
}
pub(crate) fn parse(name: &str, value: &Value) -> Result<Operation> {
    Ok(match name {
        "sequence.run" | "click.repeat" => Operation::Android,
        "windows.mouse.position" if value.as_object().is_some_and(|map| map.is_empty()) => {
            Operation::Position
        }
        "windows.mouse.click" => Operation::Click(decode(value)?),
        "windows.mouse.repeat" => {
            let input: MouseRepeat = decode(value)?;
            input.validate()?;
            Operation::Repeat(input)
        }
        "input_trace.record" => {
            let input: Record = decode(value)?;
            if input.event_type > 2
                || !(2..=1000).contains(&input.interval_ms)
                || !(100..=600000).contains(&input.duration_ms)
            {
                return Err(Error::Invalid("录制事件类型、采样间隔或持续时间无效"));
            }
            Operation::Record(input)
        }
        "input_trace.playback" => {
            let input: Playback = decode(value)?;
            text(&input.artifact_id, 200)?;
            if input.event_type > 2 {
                return Err(Error::Invalid("回放事件类型无效"));
            }
            Operation::Playback(input)
        }
        _ => return Err(Error::Invalid("未知自动化操作或位置查询含额外字段")),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn bounded_repeat_and_record_match_original_cli_minimum() {
        assert!(parse("windows.mouse.repeat",&json!({"button":"left","click":"double","interval_ms":10,"repeat":{"kind":"manual","max_duration_ms":100}})).is_ok());
        assert!(parse("windows.mouse.repeat",&json!({"button":"left","click":"single","interval_ms":60000,"repeat":{"kind":"count","count":12}})).is_err());
        assert!(
            parse(
                "input_trace.record",
                &json!({"event_type":0,"interval_ms":1,"duration_ms":100})
            )
            .is_err()
        );
        assert!(parse("windows.mouse.position", &json!({"path":"unexpected"})).is_err());
    }
}
