//! 容量和时钟集中定义；测试可缩小预算，不依赖后台扫描任务。

use super::{DebuggerError, ErrorCode, Result};
use std::{sync::Arc, time::Duration};

pub trait DebuggerClock: Send + Sync {
    fn now(&self) -> Duration;
}

pub(super) struct MonotonicClock(tokio::time::Instant);

impl MonotonicClock {
    pub fn shared() -> Arc<dyn DebuggerClock> {
        Arc::new(Self(tokio::time::Instant::now()))
    }
}

impl DebuggerClock for MonotonicClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}

#[derive(Debug, Clone)]
pub struct DebuggerConfig {
    pub instance_ttl: Duration,
    pub session_ttl: Duration,
    pub read_timeout: Duration,
    pub action_timeout: Duration,
    pub reload_timeout: Duration,
    pub max_instances: usize,
    pub max_sessions: usize,
    pub max_session_history: usize,
    pub max_command_history: usize,
    pub max_result_bytes: usize,
    pub max_events: usize,
    pub max_event_bytes: usize,
}

impl Default for DebuggerConfig {
    fn default() -> Self {
        Self {
            instance_ttl: Duration::from_secs(60),
            session_ttl: Duration::from_secs(30 * 60),
            read_timeout: Duration::from_secs(5),
            action_timeout: Duration::from_secs(10),
            reload_timeout: Duration::from_secs(30),
            max_instances: 32,
            max_sessions: 128,
            max_session_history: 256,
            max_command_history: 256,
            max_result_bytes: 16 * 1024 * 1024,
            max_events: 10_000,
            max_event_bytes: 16 * 1024 * 1024,
        }
    }
}

impl DebuggerConfig {
    pub(super) fn validate(&self) -> Result<()> {
        let defaults = Self::default();
        let counts = [
            (self.max_instances, defaults.max_instances),
            (self.max_sessions, defaults.max_sessions),
            (self.max_session_history, defaults.max_session_history),
            (self.max_command_history, defaults.max_command_history),
            (self.max_result_bytes, defaults.max_result_bytes),
            (self.max_events, defaults.max_events),
            (self.max_event_bytes, defaults.max_event_bytes),
        ];
        let durations = [
            (self.instance_ttl, defaults.instance_ttl),
            (self.session_ttl, defaults.session_ttl),
            (self.read_timeout, defaults.read_timeout),
            (self.action_timeout, defaults.action_timeout),
            (self.reload_timeout, defaults.reload_timeout),
        ];
        if counts.iter().any(|(n, maximum)| *n == 0 || n > maximum)
            || durations
                .iter()
                .any(|(n, maximum)| n.as_millis() == 0 || n > maximum)
        {
            return Err(DebuggerError {
                code: ErrorCode::InvalidInput,
                message: "调试器预算必须为正且不超过默认硬上限".into(),
            });
        }
        Ok(())
    }
}

pub(super) fn millis(duration: Duration) -> u64 {
    duration.as_millis().min(u64::MAX as u128) as u64
}
