use apk_domain::{Error, Result, performance::*};
use apk_infrastructure::performance::store::SqlitePerformance;
use std::sync::{
    Arc, Condvar, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use tokio::sync::Notify;

pub const TERMINAL_ERROR: &str = "模拟终态持久化失败";

pub struct Gate {
    open: Mutex<bool>,
    changed: Condvar,
    pub entered: Notify,
}

impl Gate {
    fn new() -> Self {
        Self {
            open: Mutex::new(false),
            changed: Condvar::new(),
            entered: Notify::new(),
        }
    }

    fn block(&self) {
        let mut open = self.open.lock().unwrap();
        self.entered.notify_one();
        while !*open {
            open = self.changed.wait(open).unwrap();
        }
    }

    pub fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.changed.notify_all();
    }

    pub fn release_on_drop(self: &Arc<Self>) -> ReleaseGuard {
        ReleaseGuard(self.clone())
    }
}

pub struct ReleaseGuard(Arc<Gate>);
impl Drop for ReleaseGuard {
    fn drop(&mut self) {
        self.0.release();
    }
}

pub struct BlockingStore {
    pub inner: SqlitePerformance,
    pub gate: Arc<Gate>,
    block_create: AtomicBool,
    pub next_get: Arc<AtomicBool>,
    pub created: Mutex<Option<PerformanceSession>>,
    pub append_calls: AtomicU64,
    pub terminal_failures: AtomicU64,
    pub terminal_attempts: AtomicU64,
}

impl BlockingStore {
    pub fn new(block_create: bool) -> Arc<Self> {
        Arc::new(Self {
            inner: SqlitePerformance::open(":memory:").unwrap(),
            gate: Arc::new(Gate::new()),
            block_create: AtomicBool::new(block_create),
            next_get: Arc::new(AtomicBool::new(false)),
            created: Mutex::new(None),
            append_calls: AtomicU64::new(0),
            terminal_failures: AtomicU64::new(0),
            terminal_attempts: AtomicU64::new(0),
        })
    }
}

impl PerformanceStore for BlockingStore {
    fn create(&self, session: PerformanceSession) -> Result<()> {
        *self.created.lock().unwrap() = Some(session.clone());
        if self.block_create.swap(false, Ordering::AcqRel) {
            self.gate.block();
        }
        self.inner.create(session)
    }

    fn get(&self, id: &str) -> Result<PerformanceSession> {
        // 来源在返回 Raw 后只武装一次，此处阻塞提交闭包里的状态读取。
        if self.next_get.swap(false, Ordering::AcqRel) {
            self.gate.block();
        }
        self.inner.get(id)
    }

    fn transition(
        &self,
        id: &str,
        revision: u64,
        state: PerformanceState,
        error: Option<String>,
    ) -> Result<PerformanceSession> {
        if state.terminal() {
            self.terminal_attempts.fetch_add(1, Ordering::AcqRel);
            if self
                .terminal_failures
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                return Err(Error::Storage(TERMINAL_ERROR.into()));
            }
        }
        self.inner.transition(id, revision, state, error)
    }

    fn append(&self, id: &str, revision: u64, raw: RawPerformance) -> Result<bool> {
        self.append_calls.fetch_add(1, Ordering::AcqRel);
        self.inner.append(id, revision, raw)
    }

    fn samples(&self, id: &str, after: u64, limit: u32) -> Result<PerformancePage> {
        self.inner.samples(id, after, limit)
    }

    fn list(&self, after_id: Option<&str>, limit: u32) -> Result<PerformanceSessions> {
        self.inner.list(after_id, limit)
    }

    fn recover(&self) -> Result<u64> {
        self.inner.recover()
    }
}
