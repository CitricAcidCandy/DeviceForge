use std::time::Duration;

/// 累计输入和双路合计输出分别有界；传输宽限不授予新的业务预算。
#[derive(Debug, Clone, Copy)]
pub struct SessionOptions {
    pub channel_capacity: usize,
    pub input_limit: u64,
    pub output_limit: u64,
    pub handshake_timeout: Duration,
    pub transport_grace: Duration,
}

impl Default for SessionOptions {
    fn default() -> Self {
        Self {
            channel_capacity: 8,
            input_limit: 1024 * 1024,
            output_limit: 16 * 1024 * 1024,
            handshake_timeout: Duration::from_secs(5),
            transport_grace: Duration::from_secs(2),
        }
    }
}

impl SessionOptions {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=64).contains(&self.channel_capacity) {
            return Err("会话通道容量须为1至64".into());
        }
        if self.input_limit > 64 * 1024 * 1024 || self.output_limit > 64 * 1024 * 1024 {
            return Err("会话累计输入和输出限额各不得超过64 MiB".into());
        }
        if self.handshake_timeout.is_zero() || self.handshake_timeout > Duration::from_secs(30) {
            return Err("会话握手期限须大于零且不超过30秒".into());
        }
        if self.transport_grace.is_zero() || self.transport_grace > Duration::from_secs(5) {
            return Err("会话终态传输宽限须大于零且不超过5秒".into());
        }
        Ok(())
    }
}
