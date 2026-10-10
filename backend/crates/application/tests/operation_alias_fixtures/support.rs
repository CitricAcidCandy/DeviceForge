//! 真实进程、SQLite、设备目录和独立证据门闩；不启动服务器或外部工具。
use super::config::{self, PROVIDER};
use apk_application::{
    Application, devices::DeviceService, operation_aliases::Config, plugin_lifecycle::PluginService,
};
use apk_domain::{
    Error, Executor, Job, Result,
    devices::{DeviceActionRequest, ProviderInput},
    plugins::{PluginCatalog, PluginContribution},
};
use apk_infrastructure::{plugins::ProcessPlugin, store::SqliteStore};
use async_trait::async_trait;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub fn node() -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::split_paths(&std::env::var_os("PATH").expect("真实别名回归需要 Node PATH"))
        .map(|root| root.join(name))
        .find(|path| path.is_file())
        .expect("真实别名回归需要 Node")
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let running = std::fs::read_dir(&self.marker)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".started.json")
            })
            .filter_map(|entry| std::fs::read(entry.path()).ok())
            .filter_map(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .any(|event| alive(pid(&event)));
        // 只保留本次失败证据，不终止未知 PID，不删除其他测试或用户目录。
        if (std::thread::panicking() || running)
            && let Some(directory) = self.directory.take()
        {
            eprintln!("别名测试证据保留：{}", directory.keep().display());
        }
    }
}

pub async fn settled(app: &Application, id: &str) -> Job {
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        let job = app.get_async(id.into()).await.unwrap();
        if job.status.is_terminal() {
            return job;
        }
        assert!(
            Instant::now() < deadline,
            "任务 {id} 未收敛：{:?}",
            job.status
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

pub async fn paused_until<T>(stage: &str, mut observed: impl FnMut() -> Option<T>) -> T {
    let frozen = tokio::time::Instant::now();
    let watchdog = Instant::now() + Duration::from_secs(12);
    loop {
        assert_eq!(
            tokio::time::Instant::now(),
            frozen,
            "等待 {stage} 时业务时钟不得自动推进"
        );
        if let Some(value) = observed() {
            return value;
        }
        assert!(Instant::now() < watchdog, "未到达 {stage} 观察点");
        // 持续保持可运行任务，防止真实 SQLite/Node I/O 使暂停时钟自动跳到期限。
        tokio::task::yield_now().await;
    }
}

pub fn pid(event: &Value) -> u32 {
    u32::try_from(event["pid"].as_u64().expect("夹具 PID")).unwrap()
}

pub async fn wait_gone(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) {
        assert!(Instant::now() < deadline, "本次直接 PID {pid} 未退出");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(windows)]
pub fn alive(pid: u32) -> bool {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    let handle = unsafe { OpenProcess(0x0010_0000, 0, pid) };
    if handle.is_null() {
        assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(87));
        return false;
    }
    let state = unsafe { WaitForSingleObject(handle, 0) };
    assert_ne!(unsafe { CloseHandle(handle) }, 0);
    match state {
        0 => false,
        258 => true,
        _ => panic!("本次 PID 状态查询失败：{state}"),
    }
}

#[cfg(unix)]
pub fn alive(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    // 信号零只观察存在性，不能作为外部资源或进程树清理证据。
    if unsafe { kill(i32::try_from(pid).unwrap(), 0) } == 0 {
        return true;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(3) => false,
        Some(1) => true,
        error => panic!("本次 PID 观察失败：{error:?}"),
    }
}

pub fn code<T>(result: Result<T>) -> &'static str {
    match result {
        Err(error) => error.code(),
        Ok(_) => panic!("预期精确领域错误"),
    }
}

pub struct Catalog {
    manifest: Value,
    current: Mutex<Option<Arc<ProcessPlugin>>>,
}
#[async_trait]
impl PluginCatalog for Catalog {
    async fn load(&self, id: &str) -> Result<PluginContribution> {
        if id != PROVIDER {
            return Err(Error::NotFound(id.into()));
        }
        // 类型由公开构造器推导，不为测试增加 SDK 生产依赖。
        let plugin = Arc::new(ProcessPlugin::new(
            serde_json::from_value(self.manifest.clone())
                .map_err(|error| Error::Invalid(error.to_string()))?,
        )?);
        *self.current.lock().unwrap() = Some(plugin.clone());
        Ok(PluginContribution {
            id: id.into(),
            version: "1".into(),
            executor: plugin,
        })
    }
}

pub struct Fixture {
    directory: Option<tempfile::TempDir>,
    protocol: u32,
    pub marker: PathBuf,
    pub app: Arc<Application>,
    pub plugins: Arc<PluginService>,
    pub devices: Arc<DeviceService>,
    catalog: Arc<Catalog>,
}
impl Fixture {
    pub fn unloaded(
        protocol: u32,
        bindings: Config,
        timeout: Option<u64>,
        executors: Vec<Arc<dyn Executor>>,
    ) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("markers");
        std::fs::create_dir(&marker).unwrap();
        let catalog = Arc::new(Catalog {
            manifest: config::manifest(protocol, &marker, timeout),
            current: Mutex::new(None),
        });
        let app = Application::new_with_bindings(
            Arc::new(SqliteStore::open(":memory:").unwrap()),
            executors,
            4,
            32,
            bindings,
        )
        .unwrap();
        let plugins = PluginService::new(app.clone(), catalog.clone(), Default::default());
        let devices = DeviceService::new(app.clone());
        Self {
            directory: Some(directory),
            protocol,
            marker,
            app,
            plugins,
            devices,
            catalog,
        }
    }

    pub async fn new(protocol: u32, bindings: Config) -> Self {
        Self::with_timeout(protocol, bindings, None).await
    }

    pub async fn with_timeout(protocol: u32, bindings: Config, timeout: Option<u64>) -> Self {
        let fixture = Self::unloaded(protocol, bindings, timeout, vec![]);
        fixture.plugins.load(PROVIDER.into()).await.unwrap();
        fixture.refresh().await;
        fixture
    }

    pub fn provider(&self) -> ProviderInput {
        let provider = self
            .devices
            .providers()
            .into_iter()
            .find(|item| item.id == PROVIDER)
            .unwrap();
        ProviderInput {
            id: provider.id,
            generation: provider.generation,
        }
    }

    pub async fn refresh(&self) {
        let directory = self.devices.refresh(self.provider()).await.unwrap();
        assert_eq!(directory.devices.len(), 2);
    }

    pub fn action(
        &self,
        capability: &str,
        device: Option<&str>,
        label: &str,
        mode: &str,
    ) -> DeviceActionRequest {
        let provider = self.provider();
        DeviceActionRequest {
            provider_id: provider.id,
            generation: provider.generation,
            device_id: device.map(str::to_owned),
            capability: capability.into(),
            version: 1,
            input: config::old_input(label, None, mode),
        }
    }

    pub fn plugin(&self) -> Arc<ProcessPlugin> {
        self.catalog.current.lock().unwrap().clone().unwrap()
    }

    pub fn recorded(&self, label: &str, event: &str) -> Option<Value> {
        std::fs::read(self.marker.join(format!("{label}.{event}.json")))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }

    pub async fn event(&self, label: &str, event: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            if let Some(value) = self.recorded(label, event) {
                return value;
            }
            assert!(
                Instant::now() < deadline,
                "缺少 {label}/{event} 证据：{}",
                self.marker.display()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub async fn ready(&self, label: &str) -> Value {
        let value = self.event(label, "ready").await;
        assert!(alive(pid(&value)), "真实就绪标记须对应本次运行 PID");
        value
    }

    pub fn release(&self, label: &str) {
        std::fs::write(self.marker.join(format!("{label}.release")), b"release").unwrap();
    }

    pub async fn blocked(&self, labels: &[&str]) {
        // 正向对照已就绪之后观察负向门闩；不用紧期限要求进程必须及时启动。
        let until = Instant::now() + Duration::from_millis(200);
        while Instant::now() < until {
            for label in labels {
                assert!(
                    self.recorded(label, "started").is_none(),
                    "{label} 不应越过共享锁"
                );
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub async fn exited(&self, label: &str) {
        let event = self.event(label, "process_exit").await;
        assert_eq!(event["code"], 0);
        wait_gone(pid(&event)).await;
        assert_eq!(
            self.event(label, "response_written").await["pid"],
            event["pid"]
        );
        if self.protocol == 3 {
            assert_eq!(self.event(label, "stdin_eof").await["pid"], event["pid"]);
        }
    }

    pub async fn shutdown(&self) {
        self.plugins.close();
        self.plugins.wait().await;
        tokio::time::timeout(Duration::from_secs(10), self.app.shutdown())
            .await
            .expect("测试宿主应在既有十秒观察上限内退出")
            .unwrap();
    }
}
