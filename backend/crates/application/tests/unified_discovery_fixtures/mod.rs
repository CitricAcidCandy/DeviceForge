//! 只使用公开应用服务与领域端口，私有门禁窗口由主代理另补测试。
pub mod executor;
pub mod store;
use apk_application::{
    Application, devices::DeviceService, operation_aliases::Config, plugin_lifecycle::PluginService,
};
use apk_domain::{
    Error, Job, JobStatus, JobStore, Result,
    devices::{DeviceDirectory, ProviderInput},
    plugins::{PluginCatalog, PluginContribution},
};
use async_trait::async_trait;
use executor::Provider;
use serde_json::{Value, json};
use std::future::Future;
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant},
};

pub const ALIAS: &str = "android.devices";
pub fn bindings(provider: &str) -> Config {
    serde_json::from_value(json!({
        "format_version":2,
        "bindings":[{
            "operation":{"id":ALIAS,"title":"旧原文发现","input_schema":{"type":"object"}},
            "target":{"kind":"device_discovery","plugin_id":provider},
            "input":"identity",
            "result":{"kind":"device_discovery","platform":"android"},
        }],
    }))
    .expect("RAW-02 格式2公开配置必须能解析")
}
struct Catalog(BTreeMap<String, Arc<Provider>>);
#[async_trait]
impl PluginCatalog for Catalog {
    async fn load(&self, id: &str) -> Result<PluginContribution> {
        let provider = self
            .0
            .get(id)
            .cloned()
            .ok_or_else(|| Error::NotFound(id.into()))?;
        Ok(PluginContribution {
            id: id.into(),
            version: "1".into(),
            executor: provider,
        })
    }
}
pub struct Fixture {
    pub app: Arc<Application>,
    pub devices: Arc<DeviceService>,
    pub plugins: Arc<PluginService>,
    pub store: Arc<store::Store>,
    pub providers: Vec<Arc<Provider>>,
}
impl Fixture {
    pub async fn new(providers: Vec<Arc<Provider>>, concurrency: usize, aliases: bool) -> Self {
        Self::with_store(
            providers,
            concurrency,
            aliases,
            Arc::new(store::Store::default()),
        )
        .await
    }
    pub async fn with_store(
        providers: Vec<Arc<Provider>>,
        concurrency: usize,
        aliases: bool,
        store: Arc<store::Store>,
    ) -> Self {
        let config = if aliases {
            bindings(&providers[0].id)
        } else {
            Config::default()
        };
        let app =
            Application::new_with_bindings(store.clone(), vec![], concurrency, 32, config).unwrap();
        let catalog = Catalog(
            providers
                .iter()
                .map(|provider| (provider.id.clone(), provider.clone()))
                .collect(),
        );
        let plugins = PluginService::new(app.clone(), Arc::new(catalog), Default::default());
        let devices = DeviceService::new(app.clone());
        for provider in &providers {
            guarded("加载受控提供者", plugins.load(provider.id.clone()))
                .await
                .unwrap();
        }
        Self {
            app,
            devices,
            plugins,
            store,
            providers,
        }
    }
    pub fn identity(&self, provider: &Provider) -> ProviderInput {
        let info = self
            .devices
            .providers()
            .into_iter()
            .find(|info| info.id == provider.id)
            .unwrap();
        ProviderInput {
            id: info.id,
            generation: info.generation,
        }
    }
    pub fn directory(&self, provider: &Provider) -> Option<DeviceDirectory> {
        self.devices
            .directories()
            .into_iter()
            .find(|directory| directory.provider.id == provider.id)
    }
    pub async fn submit(&self, provider: &Provider, alias: bool, input: Value) -> Job {
        guarded(
            "发现提交",
            self.app.submit_async(
                if alias {
                    ALIAS.into()
                } else {
                    provider.operation()
                },
                input,
            ),
        )
        .await
        .unwrap()
    }
    pub async fn refresh(&self, provider: &Provider) -> DeviceDirectory {
        guarded(
            "refresh 接受回执",
            self.devices.refresh(self.identity(provider)),
        )
        .await
        .unwrap()
    }
    pub async fn wait_terminal(&self, id: &str) -> Job {
        until("任务终态", || {
            self.store
                .get(id)
                .ok()
                .filter(|job| job.status.is_terminal())
        })
        .await
    }
    pub async fn wait_directory(&self, provider: &Provider, id: &str) -> DeviceDirectory {
        until("本 Job 目录已接受", || {
            self.directory(provider)
                .filter(|directory| directory.discovery_job_id == id)
        })
        .await
    }
    pub async fn shutdown(&self) {
        for provider in &self.providers {
            provider.release_all();
        }
        self.store.release_all();
        self.plugins.close();
        guarded("生命周期管理收敛", self.plugins.wait()).await;
        guarded("应用停止", self.app.shutdown()).await.unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // 失败路径只释放本次受控门闩；没有真实进程或用户目录可清理。
        self.store.release_all();
        for provider in &self.providers {
            provider.release_all();
        }
    }
}
pub async fn until<T>(stage: &str, mut observed: impl FnMut() -> Option<T>) -> T {
    let frozen = tokio::time::Instant::now();
    let watchdog = Instant::now() + Duration::from_secs(12);
    loop {
        assert_eq!(
            tokio::time::Instant::now(),
            frozen,
            "观察 {stage} 不允许时钟自动推进"
        );
        if let Some(value) = observed() {
            return value;
        }
        assert!(Instant::now() < watchdog, "未到达 {stage}");
        // 持续可运行，避免受控存储线程等待使 Tokio 暂停时钟自动前进。
        tokio::task::yield_now().await;
    }
}
pub async fn guarded<T>(stage: &str, future: impl Future<Output = T>) -> T {
    let frozen = tokio::time::Instant::now();
    let watchdog = Instant::now() + Duration::from_secs(12);
    tokio::pin!(future);
    loop {
        assert_eq!(
            tokio::time::Instant::now(),
            frozen,
            "等待 {stage} 不允许业务时钟自动推进"
        );
        assert!(Instant::now() < watchdog, "等待 {stage} 未收敛");
        tokio::select! { biased;
            result = &mut future => return result,
            _ = tokio::task::yield_now() => {},
        }
    }
}
pub async fn turns() {
    let frozen = tokio::time::Instant::now();
    for _ in 0..128 {
        tokio::task::yield_now().await;
    }
    assert_eq!(tokio::time::Instant::now(), frozen);
}
pub fn code<T>(result: Result<T>) -> &'static str {
    match result {
        Err(error) => error.code(),
        Ok(_) => panic!("预期精确领域错误"),
    }
}
pub fn same_json<T: serde::Serialize>(left: &T, right: &T) {
    assert_eq!(
        serde_json::to_value(left).unwrap(),
        serde_json::to_value(right).unwrap()
    );
}
pub fn success(job: &Job) {
    assert_eq!(job.status, JobStatus::Succeeded, "{:?}", job.error);
}
