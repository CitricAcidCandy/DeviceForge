//! 协议 5 的独立交互会话契约；不拥有时钟、进程或宿主资源。
mod frames;
mod handshake;
mod validation;

pub use frames::{SessionControl, SessionEvent, SessionOutcome, SessionStream};
pub use handshake::{SessionClient, SessionOpen, SessionOpenCommand, SessionReady, SessionStart};

pub const SESSION_PROTOCOL_VERSION: u32 = 5;
pub const SESSION_CHUNK_LIMIT: usize = 8192;
pub const SESSION_FRAME_LIMIT: usize = 65536;
pub const SESSION_HANDSHAKE_LIMIT: usize = 4096;
pub const SESSION_OPEN_LIMIT: usize = 512 * 1024;
pub const SESSION_FINISH_LIMIT: usize = 1024 * 1024;
