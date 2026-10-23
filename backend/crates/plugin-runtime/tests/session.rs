//! 手工协议 5 原帧与内存双工行为证据；不声称宿主、外部进程或真机验收。

#[path = "session/duplex.rs"]
mod duplex;
#[path = "session/lifecycle.rs"]
mod lifecycle;
#[path = "session/limits.rs"]
mod limits;
#[path = "session/rejection.rs"]
mod rejection;
#[path = "session/support.rs"]
mod support;
#[path = "session/transport_recovery.rs"]
mod transport_recovery;
