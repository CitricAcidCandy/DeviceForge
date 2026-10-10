use crate::{Error, ExecutionOptions, Result};

/// 流式执行沿用原绝对期限；每块输入与输出使用同一分片上限。
#[derive(Debug, Clone, Copy)]
pub struct StreamOptions {
    pub execution: ExecutionOptions,
    pub chunk_size: usize,
    pub channel_capacity: usize,
    pub input_limit: u64,
}

impl StreamOptions {
    pub fn new(execution: ExecutionOptions) -> Self {
        Self {
            execution,
            chunk_size: 8192,
            channel_capacity: 8,
            input_limit: 1024 * 1024,
        }
    }

    pub(super) fn validate(&self) -> Result<()> {
        self.execution.validate()?;
        if !(1..=65536).contains(&self.chunk_size) {
            return Err(Error::InvalidOptions("流式分片须为1至65536字节"));
        }
        if !(1..=64).contains(&self.channel_capacity) {
            return Err(Error::InvalidOptions("流式通道容量须为1至64"));
        }
        Ok(())
    }
}
