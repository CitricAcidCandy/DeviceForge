use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Business {
    pub action: Action,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub(super) enum Action {
    #[serde(rename = "tap")]
    Tap { x: u32, y: u32 },
    #[serde(rename = "swipe")]
    Swipe {
        x1: u32,
        y1: u32,
        x2: u32,
        y2: u32,
        #[serde(default = "default_velocity")]
        velocity_pps: u32,
    },
    #[serde(rename = "keyevent")]
    KeyEvent { key_code: u32 },
    #[serde(rename = "text")]
    Text {
        x: u32,
        y: u32,
        text: String,
        #[serde(default)]
        enter: bool,
    },
}

fn default_velocity() -> u32 {
    600
}

impl Action {
    pub(super) fn kind(&self) -> &'static str {
        match self {
            Self::Tap { .. } => "tap",
            Self::Swipe { .. } => "swipe",
            Self::KeyEvent { .. } => "keyevent",
            Self::Text { .. } => "text",
        }
    }

    pub(super) fn enter(&self) -> bool {
        matches!(self, Self::Text { enter: true, .. })
    }
}
