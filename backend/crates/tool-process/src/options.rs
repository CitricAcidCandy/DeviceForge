use crate::{Error, Result};
use std::{collections::BTreeMap, ffi::OsString, path::Path, time::Duration};
use tokio::time::Instant;

pub const DEFAULT_OUTPUT_LIMIT: u64 = 1024 * 1024;
pub const MAX_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);

/// 受限模式只继承公共白名单中的程序查找、系统、目录与终端运行环境。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Environment {
    #[default]
    Inherit,
    Restricted,
}

/// 参数逐项交给操作系统，不经过 shell；请求字节由调用方准备和限额。
#[derive(Debug)]
pub struct ToolCommand<'a> {
    pub executable: &'a str,
    pub args: &'a [String],
    pub input: Option<&'a [u8]>,
    pub directory: Option<&'a Path>,
    pub environment: Environment,
    pub env: BTreeMap<OsString, OsString>,
}

impl<'a> ToolCommand<'a> {
    pub fn new(executable: &'a str, args: &'a [String]) -> Self {
        Self {
            executable,
            args,
            input: None,
            directory: None,
            environment: Environment::Inherit,
            env: BTreeMap::new(),
        }
    }
}

/// 绝对截止时间可与排队、设备锁及副本准备共享，不重新计时。
#[derive(Debug, Clone, Copy)]
pub struct ExecutionOptions {
    pub deadline: Instant,
    pub stdout_limit: u64,
    pub stderr_limit: u64,
    pub cleanup_timeout: Duration,
}

impl ExecutionOptions {
    pub fn new(deadline: Instant) -> Self {
        Self {
            deadline,
            stdout_limit: DEFAULT_OUTPUT_LIMIT,
            stderr_limit: DEFAULT_OUTPUT_LIMIT,
            cleanup_timeout: MAX_CLEANUP_TIMEOUT,
        }
    }

    pub(crate) fn validate(&self) -> Result<()> {
        if self.cleanup_timeout.is_zero() || self.cleanup_timeout > MAX_CLEANUP_TIMEOUT {
            return Err(Error::InvalidOptions("清理期限须大于零且不超过两秒"));
        }
        Ok(())
    }
}
