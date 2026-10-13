//! 堆栈报告公开数据；纳秒和事件计数用十进制字符串保留u64精度。
use serde::Serialize;
#[derive(Debug, Serialize)]
pub(crate) struct Report {
    pub samples: Vec<StackSample>,
    pub lost_count: u64,
    pub reported_sample_count: u64,
    pub events: Vec<String>,
}
#[derive(Debug, Serialize)]
pub(crate) struct StackSample {
    pub time_ns: String,
    pub thread_id: u32,
    pub process_id: Option<u32>,
    pub thread_name: Option<String>,
    pub event_count: String,
    pub event_type: Option<String>,
    pub callchain: Vec<StackFrame>,
    pub unwinding: Option<Unwinding>,
}
#[derive(Debug, Serialize)]
pub(crate) struct StackFrame {
    pub file: Option<String>,
    pub symbol: Option<String>,
    pub address: String,
    pub execution_type: String,
}
#[derive(Debug, Serialize)]
pub(crate) struct Unwinding {
    pub raw_error_code: Option<u32>,
    pub error_code: Option<u32>,
    pub error_address: Option<String>,
}
