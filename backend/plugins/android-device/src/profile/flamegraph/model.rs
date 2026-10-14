//! folded 导出的本地选项与精确汇总，不把事件计数解释为耗时。
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Weight {
    #[default]
    Samples,
    EventCount,
}

#[derive(Debug, Default)]
pub(crate) struct Options {
    pub weight: Weight,
    pub process_id: Option<u32>,
    pub thread_id: Option<u32>,
    pub begin_ns: Option<u64>,
    pub end_ns: Option<u64>,
}

#[derive(Debug, Serialize)]
pub(crate) struct Folded {
    pub text: String,
    pub summary: Summary,
}

#[derive(Debug, Serialize)]
pub(crate) struct Summary {
    pub format_version: u32,
    pub clock: &'static str,
    pub weight: Weight,
    pub process_id: Option<u32>,
    pub thread_id: Option<u32>,
    pub begin_ns: Option<String>,
    pub end_ns: Option<String>,
    pub input_sample_count: usize,
    pub included_sample_count: usize,
    pub drawn_sample_count: usize,
    pub folded_stack_count: usize,
    pub total_weight: String,
    pub drawn_weight: String,
    pub empty_callchain_weight: String,
    pub quality: Quality,
}

#[derive(Debug, Default, Serialize)]
pub(crate) struct Quality {
    pub empty_callchain_sample_count: usize,
    pub single_frame_sample_count: usize,
    pub max_callchain_depth: usize,
    pub unwinding_error_sample_count: usize,
    pub unwinding_metadata_missing_sample_count: usize,
    pub missing_symbol_sample_count: usize,
    pub missing_symbol_frame_count: usize,
}
