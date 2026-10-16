mod rules;
mod state;
mod storage;

pub use state::{Command, View};
use state::{State, identifier};
use std::{fs::File, path::PathBuf, sync::Arc};
use storage::{Paths, blocking};

pub struct Ownership {
    paths: Paths,
    client_id: String,
    alive: Arc<File>,
}

pub struct Guard {
    paths: Paths,
    client_id: String,
    lock: Arc<File>,
    _alive: Arc<File>,
    state: State,
    saved_revision: u64,
    owner_alive: bool,
}

impl Ownership {
    pub async fn new(device_id: &str, client_id: &str) -> Result<Self, String> {
        if device_id.is_empty()
            || device_id.len() > 200
            || device_id.starts_with('-')
            || !device_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        {
            return Err("设备控制设备标识无效".into());
        }
        identifier(client_id)?;
        let device_id = device_id.to_owned();
        let client_id = client_id.to_owned();
        blocking(move || {
            let executable = std::env::current_exe().map_err(|_| "无法定位投屏插件入口")?;
            let root = executable
                .parent()
                .ok_or("无法定位投屏插件部署目录")?
                .join(".mirroring-control");
            Self::at(root, &device_id, &client_id)
        })
        .await
    }

    fn at(root: PathBuf, device_id: &str, client_id: &str) -> Result<Self, String> {
        let paths = Paths::new(root, device_id);
        let _coordination = paths.acquire()?;
        let alive = Arc::new(paths.acquire_live(client_id)?);
        Ok(Self {
            paths,
            client_id: client_id.into(),
            alive,
        })
    }

    pub async fn register(&self, allowed: bool, master: bool) -> Result<(), String> {
        let mut guard = self.lock().await?;
        let client_id = self.client_id.clone();
        guard.mutate(|state| state.register(&client_id, allowed, master))?;
        guard.save().await
    }

    pub async fn lock(&self) -> Result<Guard, String> {
        let paths = self.paths.clone();
        let client_id = self.client_id.clone();
        let alive = self.alive.clone();
        blocking(move || {
            let lock = Arc::new(paths.acquire()?);
            let mut state = paths.read()?;
            let mut dead = Vec::new();
            for participant in &state.participants {
                if participant.client_id != client_id && !paths.alive(&participant.client_id)? {
                    dead.push(participant.client_id.clone());
                }
            }
            let before = state.revision;
            state.prune(&dead)?;
            let owner_alive = match &state.owner_id {
                Some(owner) if owner == &client_id => true,
                Some(owner) => paths.alive(owner)?,
                None => false,
            };
            if state.revision != before {
                paths.save(&state)?;
            }
            let saved_revision = state.revision;
            Ok(Guard {
                paths,
                client_id,
                lock,
                _alive: alive,
                state,
                saved_revision,
                owner_alive,
            })
        })
        .await
    }

    pub async fn unregister(&self, clean: bool) -> Result<(), String> {
        let mut guard = self.lock().await?;
        let client_id = self.client_id.clone();
        guard.mutate(|state| state.unregister(&client_id, clean))?;
        guard.save().await
    }
}

impl Guard {
    pub fn view(&self) -> View {
        self.state.view(&self.client_id)
    }

    fn mutate(
        &mut self,
        work: impl FnOnce(&mut State) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut next = self.state.clone();
        work(&mut next)?;
        next.validate()?;
        self.state = next;
        Ok(())
    }

    pub fn command(&mut self, command: Command) -> Result<(), String> {
        if matches!(command, Command::Reclaim) && self.state.blocked && self.owner_alive {
            return Err("旧控制会话仍存活，不能跳过资源释放确认".into());
        }
        let client_id = self.client_id.clone();
        self.mutate(|state| state.command(&client_id, command))
    }

    pub fn needs_handoff(&self) -> bool {
        self.state.owner_id.as_deref() == Some(self.client_id.as_str())
            && self.state.transitioning
            && !self.state.blocked
    }

    pub fn finish_handoff(&mut self) -> Result<(), String> {
        let client_id = self.client_id.clone();
        self.mutate(|state| state.finish_handoff(&client_id))
    }

    pub fn is_owner(&self) -> bool {
        self.state.is_owner(&self.client_id)
    }

    pub fn needs_recovery(&self) -> bool {
        self.state.blocked
            && !self.owner_alive
            && self.state.recovery_id.as_deref() == Some(self.client_id.as_str())
            && self
                .state
                .participant(&self.client_id)
                .is_some_and(|entry| entry.allowed && entry.master)
    }

    #[cfg(test)]
    pub fn finish_recovery(&mut self) -> Result<(), String> {
        if !self.needs_recovery() {
            return Err("旧设备控制端尚未进入可恢复状态".into());
        }
        let client_id = self.client_id.clone();
        self.mutate(|state| state.finish_recovery(&client_id))
    }

    pub async fn save(&mut self) -> Result<(), String> {
        if self.saved_revision == self.state.revision {
            return Ok(());
        }
        let paths = self.paths.clone();
        let state = self.state.clone();
        let revision = state.revision;
        let lock = self.lock.clone();
        blocking(move || {
            let _lock = lock;
            paths.save(&state)
        })
        .await?;
        self.saved_revision = revision;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
