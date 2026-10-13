use super::models::Action;
use crate::{Error, Result};

fn coordinate(value: u32) -> Result<()> {
    if !(1..=32767).contains(&value) {
        return Err(Error::Invalid("Harmony输入坐标须为1至32767整数"));
    }
    Ok(())
}

pub(super) fn key_code(value: u32) -> bool {
    matches!(
        value,
        1 | 2
            | 10..=19
            | 22
            | 23
            | 40
            | 41
            | 2000..=2122
            | 2210
            | 2600..=2632
            | 2634..=2731
            | 2800..=2834
            | 2836..=2839
            | 2841..=2847
            | 3001
            | 3100..=3109
    )
}

pub(super) fn validate(action: &Action) -> Result<()> {
    match action {
        Action::Tap { x, y } => {
            coordinate(*x)?;
            coordinate(*y)?;
        }
        Action::Swipe {
            x1,
            y1,
            x2,
            y2,
            velocity_pps,
        } => {
            for value in [x1, y1, x2, y2] {
                coordinate(*value)?;
            }
            if !(200..=40000).contains(velocity_pps) || (x1, y1) == (x2, y2) {
                return Err(Error::Invalid(
                    "Harmony滑动须有位移，速度须为200至40000像素每秒",
                ));
            }
        }
        Action::KeyEvent { key_code: value } => {
            if !key_code(*value) {
                return Err(Error::Invalid("Harmony按键码不在固定官方档案的可用表中"));
            }
        }
        Action::Text { x, y, text, .. } => {
            coordinate(*x)?;
            coordinate(*y)?;
            if text.is_empty() || text.len() > 1024 || text.chars().any(char::is_control) {
                return Err(Error::Invalid(
                    "Harmony文本须为1至1024个UTF-8字节且不含控制符",
                ));
            }
        }
    }
    Ok(())
}
