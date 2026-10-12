//! 动作是可序列化业务数据，不接受任意 shell 或全局鼠标指令。
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Action {
    Tap {
        x: u32,
        y: u32,
    },
    Swipe {
        x1: u32,
        y1: u32,
        x2: u32,
        y2: u32,
        duration_ms: u32,
    },
    Key {
        code: u32,
    },
    Text {
        text: String,
    },
}
impl Action {
    fn validate(&self) -> bool {
        match self {
            Self::Tap { x, y } => *x <= 65535 && *y <= 65535,
            Self::Swipe {
                x1,
                y1,
                x2,
                y2,
                duration_ms,
            } => {
                [*x1, *y1, *x2, *y2].into_iter().all(|value| value <= 65535)
                    && (1..=10000).contains(duration_ms)
            }
            Self::Key { code } => *code <= 288,
            Self::Text { text } => {
                !text.is_empty()
                    && text.len() <= 1024
                    && text
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b" .,_-@".contains(&byte))
            }
        }
    }
    pub(crate) fn arguments(&self) -> Vec<String> {
        match self {
            Self::Tap { x, y } => vec!["tap".into(), x.to_string(), y.to_string()],
            Self::Swipe {
                x1,
                y1,
                x2,
                y2,
                duration_ms,
            } => vec![
                "swipe".into(),
                x1.to_string(),
                y1.to_string(),
                x2.to_string(),
                y2.to_string(),
                duration_ms.to_string(),
            ],
            Self::Key { code } => vec!["keyevent".into(), code.to_string()],
            Self::Text { text } => vec!["text".into(), text.replace(' ', "%s")],
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Step {
    pub at_ms: u64,
    pub action: Action,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Sequence {
    pub device_id: String,
    pub steps: Vec<Step>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Repeat {
    device_id: String,
    x: u32,
    y: u32,
    count: u32,
    interval_ms: u32,
}
pub(crate) fn parse(operation: &str, value: Value) -> Result<Sequence, String> {
    let sequence = match operation {
        "sequence.run" => {
            serde_json::from_value::<Sequence>(value).map_err(|_| "自动化序列无效")?
        }
        "click.repeat" => {
            let repeat: Repeat = serde_json::from_value(value).map_err(|_| "重复点击输入无效")?;
            if !(1..=10000).contains(&repeat.count) || !(10..=60000).contains(&repeat.interval_ms) {
                return Err("重复次数或间隔无效".into());
            }
            Sequence {
                device_id: repeat.device_id,
                steps: (0..repeat.count)
                    .map(|index| Step {
                        at_ms: u64::from(index) * u64::from(repeat.interval_ms),
                        action: Action::Tap {
                            x: repeat.x,
                            y: repeat.y,
                        },
                    })
                    .collect(),
            }
        }
        _ => return Err("未知自动化操作".into()),
    };
    if sequence.device_id.is_empty()
        || sequence.device_id.len() > 200
        || sequence.device_id.starts_with('-')
        || !sequence
            .device_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        || sequence.steps.is_empty()
        || sequence.steps.len() > 10000
    {
        return Err("自动化设备或步骤无效".into());
    }
    let mut previous = 0;
    for step in &sequence.steps {
        if step.at_ms < previous || step.at_ms > 3_600_000 || !step.action.validate() {
            return Err("自动化动作或顺序无效".into());
        }
        previous = step.at_ms;
    }
    Ok(sequence)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn repeat_uses_requested_interval_and_rejects_device_shell() {
        let parsed = parse(
            "click.repeat",
            json!({"device_id":"demo","x":4,"y":5,"count":3,"interval_ms":20}),
        )
        .unwrap();
        assert_eq!(
            parsed
                .steps
                .iter()
                .map(|step| step.at_ms)
                .collect::<Vec<_>>(),
            [0, 20, 40]
        );
        assert!(
            parse(
                "click.repeat",
                json!({"device_id":"demo;id","x":4,"y":5,"count":3,"interval_ms":20})
            )
            .is_err()
        );
    }
    #[test]
    fn sequence_rejects_reverse_time_and_text_shell_characters() {
        assert!(parse("sequence.run",json!({"device_id":"demo","steps":[{"at_ms":10,"action":{"kind":"tap","x":1,"y":2}},{"at_ms":9,"action":{"kind":"tap","x":1,"y":2}}]})).is_err());
        assert!(parse("sequence.run",json!({"device_id":"demo","steps":[{"at_ms":0,"action":{"kind":"text","text":"hello;reboot"}}]})).is_err());
    }
}
