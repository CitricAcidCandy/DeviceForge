//! 独立交互会话的纯契约；实际进程、传输与宿主监督留给适配器和应用层。
mod definition;
mod model;
mod ports;

pub use definition::SessionDefinition;
pub use model::{
    SessionChunk, SessionCleanup, SessionExit, SessionOutcome, SessionRequest, SessionStream,
};
pub use ports::{InteractiveSession, SessionInput, SessionLaunch, SessionProvider};
use std::sync::Arc;

pub const SESSION_PROTOCOL_VERSION: u32 = 5;
pub const SESSION_CHUNK_LIMIT: usize = 8192;

/// 共享错误使 ready 和输入失败可以缓存，不要求全局领域错误实现 Clone。
pub type SessionResult<T> = std::result::Result<T, Arc<crate::Error>>;

#[cfg(test)]
mod tests;
