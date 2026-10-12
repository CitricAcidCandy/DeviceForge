//! 真实Frida插件进程与可控独立工具进程的业务验收。
#[path = "support/lifecycle.rs"]
mod lifecycle;
#[path = "support/normal.rs"]
mod normal;
#[path = "support/rejections.rs"]
mod rejections;
mod support;
