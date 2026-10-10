//! 独立的受限归档机制与 Android 包解析；不包含宿主、工具进程或设备连接。
pub mod android;
pub mod archive;
pub mod control;
pub mod error;
pub mod models;
pub mod profiles;

pub use control::Control;
pub use error::{Error, IoStage, LimitKind, Result};
pub use models::*;
pub use profiles::{ArchiveProfile, TreeProfile};
