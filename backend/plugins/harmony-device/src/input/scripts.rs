use super::{models::Action, rules};
use crate::{Error, Result};
use sha2::{Digest, Sha256};
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(super) fn token() -> Result<String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::Dependency("输入关联标识无法取得时钟"))?
        .as_nanos();
    let seed = format!(
        "{}:{now}:{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    Ok(Sha256::digest(seed.as_bytes())
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(super) fn action(action: &Action) -> Result<String> {
    rules::validate(action)?;
    Ok(match action {
        Action::Tap { x, y } => format!("uitest uiInput click {x} {y}"),
        Action::Swipe {
            x1,
            y1,
            x2,
            y2,
            velocity_pps,
        } => format!("uitest uiInput swipe {x1} {y1} {x2} {y2} {velocity_pps}"),
        Action::KeyEvent { key_code } => format!("uitest uiInput keyEvent {key_code}"),
        Action::Text { x, y, text, .. } => {
            format!("uitest uiInput inputText {x} {y} {}", quote(text))
        }
    })
}

pub(super) fn args(
    device_id: &str,
    token: &str,
    stage: &str,
    command: &str,
) -> Result<Vec<String>> {
    crate::rules::serial(device_id)?;
    if token.len() != 32
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || !matches!(stage, "version" | "help" | "action" | "enter")
    {
        return Err(Error::Invalid("Harmony输入关联标识或阶段不符合固定格式"));
    }
    let script = format!(
        "{command} 2>&1\ninput_status=$?\nprintf '\\nDF_INPUT_DONE:{token}:{stage}:%s\\n' \"$input_status\"\n"
    );
    Ok(vec!["-t".into(), device_id.into(), "shell".into(), script])
}
