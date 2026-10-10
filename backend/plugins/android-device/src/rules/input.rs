//! 严格输入动作及设备端引用；工具argv不会替代Android shell的文本解析。
use crate::{Error, Result};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
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
    Keyevent {
        key_code: u32,
        #[serde(default)]
        long_press: bool,
    },
    Text {
        text: String,
        #[serde(default)]
        enter: bool,
    },
}

impl Action {
    pub(crate) fn validate(&self) -> Result<()> {
        let valid = match self {
            Self::Tap { x, y } => coordinate(*x) && coordinate(*y),
            Self::Swipe {
                x1,
                y1,
                x2,
                y2,
                duration_ms,
            } => {
                [*x1, *y1, *x2, *y2].into_iter().all(coordinate)
                    && (1..=10_000).contains(duration_ms)
            }
            Self::Keyevent { key_code, .. } => (1..=65_535).contains(key_code),
            Self::Text { text, .. } => {
                (1..=1024).contains(&text.len())
                    && text.bytes().all(|byte| (b' '..=b'~').contains(&byte))
            }
        };
        if !valid {
            return Err(Error::Invalid(
                "输入动作参数超出坐标、时间、按键或ASCII文本限额",
            ));
        }
        Ok(())
    }

    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Tap { .. } => "tap",
            Self::Swipe { .. } => "swipe",
            Self::Keyevent { .. } => "keyevent",
            Self::Text { .. } => "text",
        }
    }

    /// 返回固定input子命令；每笔工具调用由业务层沿同一截止点执行。
    pub(crate) fn commands(&self) -> Vec<Vec<String>> {
        match self {
            Self::Tap { x, y } => vec![vec!["tap".into(), x.to_string(), y.to_string()]],
            Self::Swipe {
                x1,
                y1,
                x2,
                y2,
                duration_ms,
            } => vec![vec![
                "swipe".into(),
                x1.to_string(),
                y1.to_string(),
                x2.to_string(),
                y2.to_string(),
                duration_ms.to_string(),
            ]],
            Self::Keyevent {
                key_code,
                long_press,
            } => {
                let mut args = vec!["keyevent".into()];
                if *long_press {
                    args.push("--longpress".into());
                }
                args.push(key_code.to_string());
                vec![args]
            }
            Self::Text { text, enter } => {
                let mut commands: Vec<_> = text_arguments(text)
                    .into_iter()
                    .map(|part| vec!["text".into(), part])
                    .collect();
                if *enter {
                    commands.push(vec!["keyevent".into(), "66".into()]);
                }
                commands
            }
        }
    }
}

fn coordinate(value: u32) -> bool {
    value <= 32_767
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn text_arguments(text: &str) -> Vec<String> {
    let mut remaining = text;
    let mut parts = Vec::new();
    // 把字面%s拆成相邻输入，避免Android input把它改为空格。
    while let Some(index) = remaining.find("%s") {
        let end = index + 1;
        parts.push(quote(&remaining[..end].replace(' ', "%s")));
        remaining = &remaining[end..];
    }
    if !remaining.is_empty() {
        parts.push(quote(&remaining.replace(' ', "%s")));
    }
    parts
}

#[cfg(test)]
#[path = "input/tests.rs"]
mod tests;
