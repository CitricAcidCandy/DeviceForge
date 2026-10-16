//! 打开与控制纯规则；不包含进程或网络副作用。
use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Open {
    pub device_id: String,
    #[serde(default = "size")]
    pub max_size: u32,
    #[serde(default = "fps")]
    pub max_fps: u32,
    #[serde(default = "rate")]
    pub video_bit_rate: u32,
    #[serde(default = "enabled")]
    pub audio: bool,
    #[serde(default = "enabled")]
    pub control: bool,
    #[serde(default)]
    pub clipboard_autosync: bool,
    #[serde(default = "retries")]
    pub reconnect_attempts: u32,
}
fn size() -> u32 {
    1280
}
fn fps() -> u32 {
    30
}
fn rate() -> u32 {
    2_000_000
}
fn enabled() -> bool {
    true
}
fn retries() -> u32 {
    2
}
impl Open {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.device_id.is_empty()
            || self.device_id.len() > 200
            || self.device_id.starts_with('-')
            || !self
                .device_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
            || !(64..=4096).contains(&self.max_size)
            || !(1..=60).contains(&self.max_fps)
            || !(128_000..=16_000_000).contains(&self.video_bit_rate)
            || self.reconnect_attempts > 5
        {
            return Err("直播设备或编码参数无效".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Action {
    Down,
    Up,
    Move,
}
impl Action {
    pub(crate) fn value(self) -> u8 {
        match self {
            Self::Down => 0,
            Self::Up => 1,
            Self::Move => 2,
        }
    }
}
fn pressure() -> f32 {
    1.0
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Control {
    Touch {
        action: Action,
        #[serde(default)]
        pointer_id: u64,
        x: u32,
        y: u32,
        width: u16,
        height: u16,
        #[serde(default = "pressure")]
        pressure: f32,
    },
    Key {
        action: Action,
        keycode: u32,
        #[serde(default)]
        repeat: u32,
        #[serde(default)]
        meta_state: u32,
    },
    Text {
        text: String,
    },
    Clipboard {
        text: String,
        #[serde(default)]
        paste: bool,
    },
    GetClipboard {
        copy_key: CopyKey,
    },
    Rotate {},
    ResetVideo {},
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CopyKey {
    None,
    Copy,
    Cut,
}
impl Control {
    pub(crate) fn encode(self) -> Result<Vec<u8>, String> {
        let mut bytes = Vec::new();
        match self {
            Self::Touch {
                action,
                pointer_id,
                x,
                y,
                width,
                height,
                pressure,
            } => {
                if width == 0
                    || height == 0
                    || x >= u32::from(width)
                    || y >= u32::from(height)
                    || !pressure.is_finite()
                    || !(0.0..=1.0).contains(&pressure)
                    || pointer_id > 9
                {
                    return Err("触摸坐标或压力无效".into());
                }
                bytes.extend([2, action.value()]);
                bytes.extend(pointer_id.to_be_bytes());
                bytes.extend(x.to_be_bytes());
                bytes.extend(y.to_be_bytes());
                bytes.extend(width.to_be_bytes());
                bytes.extend(height.to_be_bytes());
                let pressure = (pressure * 65536.0).min(65535.0) as u16;
                bytes.extend(pressure.to_be_bytes());
                bytes.extend(0_u32.to_be_bytes());
                bytes.extend(0_u32.to_be_bytes());
            }
            Self::Key {
                action,
                keycode,
                repeat,
                meta_state,
            } => {
                if matches!(action, Action::Move)
                    || keycode > 320
                    || repeat > 1000
                    || meta_state > 0x7fff_ffff
                {
                    return Err("按键参数无效".into());
                }
                bytes.extend([0, action.value()]);
                bytes.extend(keycode.to_be_bytes());
                bytes.extend(repeat.to_be_bytes());
                bytes.extend(meta_state.to_be_bytes());
            }
            Self::Text { text } => {
                text_valid(&text, 300)?;
                bytes.push(1);
                bytes.extend((text.len() as u32).to_be_bytes());
                bytes.extend(text.as_bytes());
            }
            Self::Clipboard { text, paste } => {
                text_valid(&text, 2048)?;
                bytes.push(9);
                bytes.extend(0_u64.to_be_bytes());
                bytes.push(u8::from(paste));
                bytes.extend((text.len() as u32).to_be_bytes());
                bytes.extend(text.as_bytes());
            }
            Self::GetClipboard { copy_key } => {
                bytes.extend([
                    8,
                    match copy_key {
                        CopyKey::None => 0,
                        CopyKey::Copy => 1,
                        CopyKey::Cut => 2,
                    },
                ]);
            }
            Self::Rotate {} => bytes.push(11),
            Self::ResetVideo {} => bytes.push(17),
        }
        Ok(bytes)
    }
}
fn text_valid(text: &str, limit: usize) -> Result<(), String> {
    if text.len() > limit || text.as_bytes().contains(&0) {
        return Err("控制文本无效或超限".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn strict_open_defaults_and_bounds() {
        let open: Open = serde_json::from_value(json!({"device_id":"demo"})).unwrap();
        open.validate().unwrap();
        assert!(open.audio && open.control);
        assert!(!open.clipboard_autosync);
        assert!(serde_json::from_value::<Open>(json!({"device_id":"demo","shell":"bad"})).is_err());
        let open: Open = serde_json::from_value(json!({"device_id":"-bad"})).unwrap();
        assert!(open.validate().is_err());
    }
    #[test]
    fn exact_control_bytes_and_strict_fields() {
        let control: Control =
            serde_json::from_value(json!({"type":"key","action":"down","keycode":4})).unwrap();
        assert_eq!(
            control.encode().unwrap(),
            [0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0]
        );
        assert_eq!(Control::Rotate {}.encode().unwrap(), [11]);
        assert_eq!(Control::ResetVideo {}.encode().unwrap(), [17]);
        assert!(serde_json::from_value::<Control>(json!({"type":"rotate","extra":1})).is_err());
        assert!(
            serde_json::from_value::<Control>(json!({"type":"get_clipboard","copy_key":"copy"}))
                .is_ok()
        );
        assert!(
            serde_json::from_value::<Control>(json!({"type":"get_clipboard","copy_key":"invalid"}))
                .is_err()
        );
        assert!(
            serde_json::from_value::<Control>(
                json!({"type":"get_clipboard","copy_key":"none","extra":1})
            )
            .is_err()
        );
        assert_eq!(
            Control::GetClipboard {
                copy_key: CopyKey::None
            }
            .encode()
            .unwrap(),
            [8, 0]
        );
        assert_eq!(
            Control::GetClipboard {
                copy_key: CopyKey::Copy
            }
            .encode()
            .unwrap(),
            [8, 1]
        );
        assert_eq!(
            Control::GetClipboard {
                copy_key: CopyKey::Cut
            }
            .encode()
            .unwrap(),
            [8, 2]
        );
    }
    #[test]
    fn unicode_byte_limits_and_touch_bounds() {
        assert!(
            Control::Text {
                text: "中".repeat(101)
            }
            .encode()
            .is_err()
        );
        assert!(
            Control::Touch {
                action: Action::Down,
                pointer_id: 0,
                x: 10,
                y: 0,
                width: 10,
                height: 10,
                pressure: 1.0
            }
            .encode()
            .is_err()
        );
        assert_eq!(
            Control::Text {
                text: "中文".into()
            }
            .encode()
            .unwrap()
            .len(),
            11
        );
    }
}
