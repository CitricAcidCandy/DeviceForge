//! 有界调试会话与浏览器桥接；不执行浏览器脚本或服务器业务。

mod bridge;
mod commands;
mod config;
mod events;
mod server_operations;
mod sessions;
mod state;
mod types;
mod validation;

pub use commands::{
    AutomationBinding, AutomationInput, AutomationStep, AutomationStepTool, DataCatalogInput,
    DataReadInput, DataWriteInput,
};
pub use config::{DebuggerClock, DebuggerConfig};
pub use types::*;

/// 校验已脱敏的调试结果结构与编码预算，不读取日志或文件。
pub fn validate_debug_response(value: &serde_json::Value) -> Result<()> {
    validation::response(value)
}

/// HTTP 与 MCP 共用数据、步骤和传输预算校验，不在边界另建执行器。
pub fn validate_debug_command(tool: DebugTool, parameters: &serde_json::Value) -> Result<()> {
    commands::validate(tool, parameters)
}

use std::{
    sync::{Arc, Mutex, TryLockError},
    time::Duration,
};

pub struct DebuggerService {
    config: DebuggerConfig,
    clock: Arc<dyn DebuggerClock>,
    state: Mutex<state::State>,
    changed: tokio::sync::Notify,
}

impl Default for DebuggerService {
    fn default() -> Self {
        Self::new()
    }
}

impl DebuggerService {
    pub fn new() -> Self {
        Self::with_config(DebuggerConfig::default()).expect("默认调试器配置有效")
    }

    pub fn with_config(config: DebuggerConfig) -> Result<Self> {
        Self::with_clock(config, config::MonotonicClock::shared())
    }

    pub fn with_clock(config: DebuggerConfig, clock: Arc<dyn DebuggerClock>) -> Result<Self> {
        config.validate()?;
        Ok(Self {
            config,
            clock,
            state: Mutex::new(state::State::default()),
            changed: tokio::sync::Notify::new(),
        })
    }

    fn with_state<T>(
        &self,
        operation: impl FnOnce(&mut state::State, Duration, &DebuggerConfig) -> Result<T>,
    ) -> Result<T> {
        // 临界区只处理有界内存；竞争时立即拒绝，不让请求线程无期限等锁。
        let mut state = self.state.try_lock().map_err(|failure| match failure {
            TryLockError::WouldBlock => {
                validation::error(ErrorCode::Busy, "调试器正在处理其他状态变更，请稍后重试")
            }
            TryLockError::Poisoned(_) => validation::error(ErrorCode::Internal, "调试器状态锁异常"),
        })?;
        let revision = state.revision;
        let now = self.clock.now();
        state.sweep(now, &self.config);
        let result = operation(&mut state, now, &self.config);
        let changed = state.revision != revision;
        drop(state);
        if changed {
            self.changed.notify_waiters();
        }
        result
    }
}

#[cfg(test)]
mod tests;
