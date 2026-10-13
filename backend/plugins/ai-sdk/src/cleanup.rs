use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

pub struct Cleanup {
    until: Mutex<Option<Instant>>,
    changed: tokio::sync::watch::Sender<Option<Instant>>,
}

impl Default for Cleanup {
    fn default() -> Self {
        let (changed, _) = tokio::sync::watch::channel(None);
        Self {
            until: Mutex::new(None),
            changed,
        }
    }
}

impl Cleanup {
    pub fn until(&self) -> Result<Instant, String> {
        let mut until = self.until.lock().map_err(|_| "SDK清理截止点所有权损坏")?;
        if until.is_none() {
            *until = Some(Instant::now() + Duration::from_millis(1000));
            self.changed.send_replace(*until);
        }
        until.ok_or_else(|| "SDK清理截止点缺失".into())
    }

    pub fn current(&self) -> Result<Option<Instant>, String> {
        self.until
            .lock()
            .map(|until| *until)
            .map_err(|_| "SDK清理截止点所有权损坏".into())
    }
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<Option<Instant>> {
        self.changed.subscribe()
    }
}
