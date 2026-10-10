use crate::{Error, Result};
use std::time::Instant;

/// 同步调用只借用取消检查与原绝对点，不创建计时器、线程或默认预算。
#[derive(Clone, Copy)]
pub struct Control<'a> {
    deadline: Option<Instant>,
    is_cancelled: &'a (dyn Fn() -> bool + Sync),
}

impl<'a> Control<'a> {
    pub fn new(deadline: Option<Instant>, is_cancelled: &'a (dyn Fn() -> bool + Sync)) -> Self {
        Self {
            deadline,
            is_cancelled,
        }
    }

    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    pub fn check(&self) -> Result<()> {
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(Error::Timeout);
        }
        if (self.is_cancelled)() {
            return Err(Error::Cancelled);
        }
        Ok(())
    }
}
