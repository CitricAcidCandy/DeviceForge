use apk_domain::{Error, Result};
use std::sync::{Arc, Mutex};

#[derive(Debug)]
pub(crate) struct Quota {
    max_total_bytes: u64,
    counters: Mutex<Counters>,
}

#[derive(Debug, Default)]
struct Counters {
    committed: u64,
    reserved: u64,
}

impl Quota {
    pub(crate) fn new(max_total_bytes: u64, committed: u64) -> Result<Arc<Self>> {
        Ok(Arc::new(Self {
            max_total_bytes,
            counters: Mutex::new(Counters {
                committed,
                reserved: 0,
            }),
        }))
    }

    pub(crate) fn reserve(self: &Arc<Self>, bytes: u64) -> Result<Reservation> {
        if bytes == 0 {
            return Ok(Reservation {
                quota: Arc::clone(self),
                bytes: 0,
            });
        }
        let mut counters = self
            .counters
            .lock()
            .map_err(|_| Error::Storage("产物配额状态锁已损坏".into()))?;
        let committed = counters
            .committed
            .checked_add(bytes)
            .ok_or(Error::TooLarge)?;
        if committed > self.max_total_bytes {
            return Err(Error::TooLarge);
        }
        let used = committed
            .checked_add(counters.reserved)
            .ok_or(Error::TooLarge)?;
        if used > self.max_total_bytes {
            return Err(Error::Conflict("产物总配额暂不可用".into()));
        }
        counters.reserved = counters
            .reserved
            .checked_add(bytes)
            .ok_or(Error::TooLarge)?;
        Ok(Reservation {
            quota: Arc::clone(self),
            bytes,
        })
    }

    fn release_reserved(&self, bytes: u64) {
        if bytes == 0 {
            return;
        }
        if let Ok(mut counters) = self.counters.lock() {
            counters.reserved = counters.reserved.saturating_sub(bytes);
        }
    }

    fn commit(&self, bytes: u64) -> Result<()> {
        if bytes == 0 {
            return Ok(());
        }
        let mut counters = self
            .counters
            .lock()
            .map_err(|_| Error::Storage("产物配额状态锁已损坏".into()))?;
        counters.reserved = counters
            .reserved
            .checked_sub(bytes)
            .ok_or_else(|| Error::Storage("产物预留状态不一致".into()))?;
        counters.committed = counters
            .committed
            .checked_add(bytes)
            .ok_or(Error::TooLarge)?;
        Ok(())
    }

    pub(crate) fn release_committed(&self, bytes: u64) -> Result<()> {
        let mut counters = self
            .counters
            .lock()
            .map_err(|_| Error::Storage("产物配额状态锁已损坏".into()))?;
        counters.committed = counters
            .committed
            .checked_sub(bytes)
            .ok_or_else(|| Error::Storage("产物已用配额状态不一致".into()))?;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn usage(&self) -> (u64, u64) {
        self.counters
            .lock()
            .map(|counters| (counters.committed, counters.reserved))
            .unwrap_or_default()
    }
}

pub(crate) struct Reservation {
    quota: Arc<Quota>,
    bytes: u64,
}

impl Reservation {
    pub(crate) fn reserve_more(&mut self, bytes: u64) -> Result<()> {
        if bytes == 0 {
            return Ok(());
        }
        let next = self.bytes.checked_add(bytes).ok_or(Error::TooLarge)?;
        let mut additional = self.quota.reserve(bytes)?;
        self.bytes = next;
        additional.bytes = 0;
        Ok(())
    }

    pub(crate) fn commit(mut self) -> Result<()> {
        self.quota.commit(self.bytes)?;
        self.bytes = 0;
        Ok(())
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.quota.release_reserved(self.bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reservation_is_released_or_committed() {
        let quota = Quota::new(10, 4).unwrap();
        {
            let mut reservation = quota.reserve(3).unwrap();
            reservation.reserve_more(2).unwrap();
            assert_eq!(quota.usage(), (4, 5));
        }
        assert_eq!(quota.usage(), (4, 0));
        let reservation = quota.reserve(6).unwrap();
        reservation.commit().unwrap();
        assert_eq!(quota.usage(), (10, 0));
    }

    #[test]
    fn committed_limit_and_reserved_conflict_are_distinct() {
        let quota = Quota::new(10, 8).unwrap();
        assert!(matches!(quota.reserve(3), Err(Error::TooLarge)));
        let quota = Quota::new(10, 4).unwrap();
        let _first = quota.reserve(5).unwrap();
        assert!(matches!(quota.reserve(2), Err(Error::Conflict(_))));
    }
}
