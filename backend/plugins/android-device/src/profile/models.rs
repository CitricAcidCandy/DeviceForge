//! Root录制输入及采样索引；时间和进程代际不损失整数精度。
use crate::{Error, Result, rules};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Options {
    pub package: String,
    pub duration_ms: u64,
    pub interval_ms: u64,
    #[serde(default = "capture_default")]
    pub capture_frames: bool,
}
fn capture_default() -> bool {
    true
}
impl Options {
    pub(crate) fn validate(&self) -> Result<()> {
        rules::performance::package(&self.package)?;
        if !(1000..=15000).contains(&self.duration_ms)
            || !(1000..=15000).contains(&self.interval_ms)
            || self.interval_ms > self.duration_ms
        {
            return Err(Error::Invalid("Root录制时长或采样间隔超出范围"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Identity {
    pub pid: u32,
    pub start: u64,
    pub uid: Option<u32>,
}
#[derive(Serialize)]
pub(crate) struct Index {
    pub format_version: u32,
    pub device_id: String,
    pub package: String,
    pub pid: u32,
    pub process_start_ticks: String,
    pub clock: &'static str,
    pub frame_kind: &'static str,
    pub display_frame_complete: bool,
    pub samples: Vec<Sample>,
    pub stack_sample_count: usize,
    pub reported_sample_count: String,
    pub lost_count: String,
    pub stack_status: &'static str,
    pub stack_reason: Option<&'static str>,
    pub root_access: &'static str,
    pub frame_status: &'static str,
    pub frame_reason: Option<&'static str>,
    pub symbolication: &'static str,
}
#[derive(Serialize)]
pub(crate) struct Sample {
    pub index: usize,
    pub begin_ns: String,
    pub end_ns: String,
    pub target_ns: String,
    pub metrics: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derived: Option<super::derived::Derived>,
    pub frame: Option<Frame>,
    pub stack_sample_indices: Vec<usize>,
}
#[derive(Serialize)]
pub(crate) struct Frame {
    pub index: usize,
    pub filename: String,
    pub begin_ns: String,
    pub end_ns: String,
    pub source: &'static str,
    pub epoch: u32,
    pub video_frame_index: u32,
    pub pts_us: String,
    pub device_time_ns: String,
    pub selection_delta_ns: String,
    pub clock_error_ns: String,
}
