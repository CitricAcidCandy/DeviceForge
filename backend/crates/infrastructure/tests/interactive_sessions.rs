//! 第三方协议 5 真实直接进程验收；不以夹具代替宿主、终端业务或真机。

#[path = "interactive_sessions/duplex.rs"]
mod duplex;
#[path = "interactive_sessions/lifecycle.rs"]
mod lifecycle;
#[path = "interactive_sessions/support.rs"]
mod support;
#[path = "interactive_sessions/terminal.rs"]
mod terminal;
