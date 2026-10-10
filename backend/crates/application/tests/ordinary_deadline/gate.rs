//! 同步存储副作用门闩；实际阻塞工作结束前，不把异步等待者退出视作工作退出。
use apk_domain::{Error, Result};
use std::{
    sync::{
        Condvar, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

pub struct Gate {
    open: Mutex<bool>,
    wake: Condvar,
    entered: AtomicUsize,
    exited: AtomicUsize,
}

impl Default for Gate {
    fn default() -> Self {
        Self {
            open: Mutex::new(true),
            wake: Condvar::new(),
            entered: AtomicUsize::new(0),
            exited: AtomicUsize::new(0),
        }
    }
}

impl Gate {
    pub fn close(&self) {
        *self.open.lock().unwrap() = false;
    }

    pub fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.wake.notify_all();
    }

    pub fn entered(&self) -> usize {
        self.entered.load(Ordering::SeqCst)
    }

    pub fn exited(&self) -> usize {
        self.exited.load(Ordering::SeqCst)
    }

    pub fn wait(&self, label: &str) -> Result<()> {
        self.entered.fetch_add(1, Ordering::SeqCst);
        let open = self.open.lock().unwrap();
        let (open, _) = self
            .wake
            .wait_timeout_while(open, Duration::from_secs(12), |value| !*value)
            .unwrap();
        if !*open {
            return Err(Error::Storage(format!("测试门闩失联：{label}")));
        }
        self.exited.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
