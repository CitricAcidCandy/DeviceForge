use crate::{Error, Result, identifier};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

/// 设备坐标由调用方按当前屏幕方向提供，不自动缩放。
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InputAction {
    Tap {
        #[schemars(range(min = 0, max = 32767))]
        x: u32,
        #[schemars(range(min = 0, max = 32767))]
        y: u32,
    },
    Swipe {
        #[schemars(range(min = 0, max = 32767))]
        x1: u32,
        #[schemars(range(min = 0, max = 32767))]
        y1: u32,
        #[schemars(range(min = 0, max = 32767))]
        x2: u32,
        #[schemars(range(min = 0, max = 32767))]
        y2: u32,
        #[schemars(range(min = 1, max = 10000))]
        duration_ms: u32,
    },
    Keyevent {
        #[schemars(range(min = 1, max = 65535))]
        key_code: u32,
        #[serde(default)]
        long_press: bool,
    },
    Text {
        #[schemars(length(min = 1, max = 1024), regex(pattern = r"^[ -~]+$"))]
        text: String,
        #[serde(default)]
        enter: bool,
    },
}
impl InputAction {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Tap { .. } => "tap",
            Self::Swipe { .. } => "swipe",
            Self::Keyevent { .. } => "keyevent",
            Self::Text { .. } => "text",
        }
    }
    pub fn validate(&self) -> Result<()> {
        let valid = match self {
            Self::Tap { x, y } => *x <= 32767 && *y <= 32767,
            Self::Swipe {
                x1,
                y1,
                x2,
                y2,
                duration_ms,
            } => {
                [x1, y1, x2, y2].iter().all(|value| **value <= 32767)
                    && (1..=10000).contains(duration_ms)
            }
            Self::Keyevent { key_code, .. } => (1..=65535).contains(key_code),
            Self::Text { text, .. } => {
                !text.is_empty()
                    && text.len() <= 1024
                    && text.bytes().all(|byte| (b' '..=b'~').contains(&byte))
            }
        };
        if valid {
            Ok(())
        } else {
            Err(Error::Invalid(
                "设备输入超出范围；文本仅支持最多 1024 个可打印 ASCII 字符".into(),
            ))
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InputRequest {
    #[schemars(
        length(min = 1, max = 200),
        regex(pattern = r"^[A-Za-z0-9._:\[\]][A-Za-z0-9._:\[\]-]*$")
    )]
    pub device_id: String,
    pub action: InputAction,
}
impl InputRequest {
    pub fn validate(&self) -> Result<()> {
        identifier(&self.device_id)?;
        self.action.validate()
    }
}
/// 表示所有输入命令完成，不证明界面已经接收或发生预期变化。
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct InputReceipt {
    pub device_id: String,
    pub action: String,
    pub dispatched: bool,
}
#[async_trait]
pub trait DeviceInput: Send + Sync {
    async fn dispatch(
        &self,
        request: InputRequest,
        cancel: CancellationToken,
    ) -> Result<InputReceipt>;
}
