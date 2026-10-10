//! 独立安卓包进程验收：手工公开原帧、固定样本和真实直接 PID。
mod support;

#[path = "support/cancellation.rs"]
mod cancellation;
#[path = "support/normal.rs"]
mod normal;
#[path = "support/rejections.rs"]
mod rejections;
