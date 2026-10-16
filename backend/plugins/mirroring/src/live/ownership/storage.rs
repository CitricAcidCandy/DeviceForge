use super::state::{State, identifier};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions, TryLockError},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

const IO_TIMEOUT: Duration = Duration::from_secs(3);
const STATE_LIMIT: usize = 64 * 1024;
static WORKERS: OnceLock<Arc<Semaphore>> = OnceLock::new();

#[derive(Clone)]
pub(super) struct Paths {
    pub root: PathBuf,
    pub device: String,
}

pub(super) fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

impl Paths {
    pub fn new(root: PathBuf, device_id: &str) -> Self {
        Self {
            root,
            device: digest(device_id),
        }
    }

    pub fn live(&self, client_id: &str) -> PathBuf {
        self.root
            .join(format!("{}.{}.alive", self.device, digest(client_id)))
    }

    fn state(&self) -> PathBuf {
        self.root.join(format!("{}.json", self.device))
    }

    pub fn prepare(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.root).map_err(|_| "无法创建设备控制协调目录".into())
    }

    pub fn acquire_live(&self, client_id: &str) -> Result<File, String> {
        identifier(client_id)?;
        self.prepare()?;
        let file = open_lock(&self.live(client_id))?;
        match file.try_lock() {
            Ok(()) => Ok(file),
            Err(TryLockError::WouldBlock) => Err("设备控制客户端标识已经在使用".into()),
            Err(TryLockError::Error(_)) => Err("无法锁定设备控制客户端".into()),
        }
    }

    pub fn acquire(&self) -> Result<File, String> {
        self.prepare()?;
        let file = open_lock(&self.root.join(format!("{}.lock", self.device)))?;
        let deadline = Instant::now() + IO_TIMEOUT;
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(file),
                Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(TryLockError::WouldBlock) => return Err("等待设备控制协调锁超时".into()),
                Err(TryLockError::Error(_)) => return Err("无法锁定设备控制协调文件".into()),
            }
        }
    }

    pub fn alive(&self, client_id: &str) -> Result<bool, String> {
        let file = open_lock(&self.live(client_id))?;
        match file.try_lock() {
            Ok(()) => Ok(false),
            Err(TryLockError::WouldBlock) => Ok(true),
            Err(TryLockError::Error(_)) => Err("无法核对设备控制客户端存活状态".into()),
        }
    }

    pub fn read(&self) -> Result<State, String> {
        let file = match File::open(self.state()) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(State::empty()),
            Err(_) => return Err("无法读取设备控制协调状态".into()),
        };
        let metadata = file.metadata().map_err(|_| "无法读取设备控制协调元数据")?;
        if !metadata.is_file() || metadata.len() > STATE_LIMIT as u64 {
            return Err("设备控制协调状态不是有限普通文件".into());
        }
        let mut bytes = Vec::new();
        file.take(STATE_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "设备控制协调状态读取失败")?;
        if bytes.len() > STATE_LIMIT {
            return Err("设备控制协调状态超限".into());
        }
        let state: State =
            serde_json::from_slice(&bytes).map_err(|_| "设备控制协调状态无法解析")?;
        state.validate()?;
        Ok(state)
    }

    pub fn save(&self, state: &State) -> Result<(), String> {
        state.validate()?;
        let bytes = serde_json::to_vec(state).map_err(|_| "设备控制协调状态序列化失败")?;
        if bytes.len() > STATE_LIMIT {
            return Err("设备控制协调状态超限".into());
        }
        let pending = self.root.join(format!("{}.pending", self.device));
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&pending)
            .map_err(|_| "无法创建设备控制协调临时文件")?;
        file.write_all(&bytes)
            .map_err(|_| "设备控制协调状态写入失败")?;
        file.sync_all().map_err(|_| "设备控制协调状态刷新失败")?;
        drop(file);
        std::fs::rename(pending, self.state()).map_err(|_| "设备控制协调状态发布失败".into())
    }
}

fn open_lock(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| "无法打开设备控制锁文件".into())
}

pub(super) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let workers = WORKERS.get_or_init(|| Arc::new(Semaphore::new(4))).clone();
    let permit = tokio::time::timeout(IO_TIMEOUT, workers.acquire_owned())
        .await
        .map_err(|_| "设备控制协调工作池等待超时")?
        .map_err(|_| "设备控制协调工作池已关闭")?;
    let task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    });
    tokio::time::timeout(IO_TIMEOUT + Duration::from_millis(100), task)
        .await
        .map_err(|_| "设备控制协调文件操作超时")?
        .map_err(|_| "设备控制协调工作线程失败")?
}
