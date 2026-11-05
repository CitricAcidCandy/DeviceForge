//! 锁竞争只作短暂让步；重试窗口不超过已知业务截止点，耗尽后等待真实变化。

use std::time::Duration;
use tokio::time::Instant;

#[derive(Default)]
pub(super) struct BusyRetry {
    until: Option<Instant>,
    attempts: u32,
}

impl BusyRetry {
    pub(super) fn delay(&mut self, now: Instant, deadline: Option<Instant>) -> Option<Duration> {
        let until = *self.until.get_or_insert_with(|| {
            let bounded = now + Duration::from_millis(250);
            deadline.map_or(bounded, |deadline| deadline.min(bounded))
        });
        let remaining = until.saturating_duration_since(now);
        if remaining.is_zero() {
            return None;
        }
        let delay = Duration::from_millis(5u64.saturating_mul(1u64 << self.attempts.min(3)));
        self.attempts += 1;
        Some(delay.min(remaining))
    }

    pub(super) fn reset(&mut self) {
        *self = Self::default();
    }
}
