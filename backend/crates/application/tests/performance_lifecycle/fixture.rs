use apk_application::{
    Application, performance::PerformanceService, plugin_lifecycle::PluginService,
};
use apk_domain::{
    Error, ExecutionContext, Executor, Operation, Result,
    performance::*,
    plugins::{PluginCatalog, PluginContribution},
};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

pub const SOURCE_ID: &str = "source";

#[derive(Default)]
pub struct Source {
    pub calls: AtomicU64,
    pub mode: AtomicU8,
    pub unresolved: AtomicBool,
    pub entered: Notify,
    pub cleaned: Notify,
    pub deadlines: Mutex<Vec<Option<std::time::Instant>>>,
    pub block_commit_get: Mutex<Option<Arc<AtomicBool>>>,
}

#[async_trait]
impl Executor for Source {
    fn operations(&self) -> Vec<Operation> {
        vec![Operation {
            id: "plugin.source.sample".into(),
            title: "受控性能来源".into(),
            execution: None,
            input_schema: json!({"type":"object","additionalProperties":false,
                "required":["device_id","package"],"properties":{
                    "device_id":{"type":"string"},"package":{"type":"string"}}}),
        }]
    }

    fn performance_source(&self) -> Option<PerformanceSourceDefinition> {
        Some(PerformanceSourceDefinition {
            api_version: 1,
            operation: "plugin.source.sample".into(),
            fps: false,
            device_capability: None,
        })
    }

    fn has_unresolved_resources(&self) -> bool {
        self.unresolved.load(Ordering::Acquire)
    }

    async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> Result<Value> {
        panic!("生产性能来源必须收到原执行上下文");
    }

    async fn execute_with_context(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<Value> {
        assert_eq!(operation, "plugin.source.sample");
        assert_eq!(
            input,
            json!({"device_id":"device","package":"com.example.app"})
        );
        let count = self.calls.fetch_add(1, Ordering::AcqRel) + 1;
        self.deadlines.lock().unwrap().push(context.deadline);
        let mode = self.mode.load(Ordering::Acquire);
        if mode != 0 {
            self.entered.notify_one();
            cancel.cancelled().await;
            self.cleaned.notify_one();
            if mode == 2 {
                return Err(Error::CleanupFailed);
            }
            // 清理阶段返回成功数据，用来验证控制或卸载后的晚结果被丢弃。
        }
        if let Some(armed) = self.block_commit_get.lock().unwrap().take() {
            armed.store(true, Ordering::Release);
        }
        Ok(
            json!({"captured_at":apk_domain::now(),"pid":123,"process_start_ticks":900,
            "process_ticks":100 + count * 10,"system_ticks":1000 + count * 100,
            "logical_cpus":2,"pss_kib":1024,"rss_kib":2048}),
        )
    }
}

struct Catalog(Arc<Source>);

#[async_trait]
impl PluginCatalog for Catalog {
    async fn load(&self, id: &str) -> Result<PluginContribution> {
        if id != SOURCE_ID {
            return Err(Error::NotFound(id.into()));
        }
        Ok(PluginContribution {
            id: id.into(),
            version: "1".into(),
            executor: self.0.clone(),
        })
    }
}

pub fn request(duration_secs: u32) -> PerformanceStart {
    PerformanceStart {
        target: PerformanceTarget {
            device_id: "device".into(),
            package: "com.example.app".into(),
        },
        interval_ms: 1000,
        duration_secs,
    }
}

pub async fn notified(notify: &Notify) {
    tokio::time::timeout(Duration::from_secs(3), notify.notified())
        .await
        .unwrap();
}

pub async fn wait_shutdown_started(service: &PerformanceService) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match service.start(request(30), CancellationToken::new()).await {
                Err(Error::Conflict(message)) if message.contains("正在停止") => return,
                // 关闭尚未轮询时，原会话占满容量；卸载并发时也可能先拒绝来源。
                Err(Error::Conflict(_)) => tokio::task::yield_now().await,
                outcome => panic!("等待关闭准入见证时出现非预期结果：{outcome:?}"),
            }
        }
    })
    .await
    .unwrap();
}

pub struct StartHost {
    service: PerformanceService,
    pub hold_start: AtomicBool,
    pub accepted: Notify,
    pub session: Mutex<Option<PerformanceSession>>,
}

#[async_trait]
impl Executor for StartHost {
    fn operations(&self) -> Vec<Operation> {
        self.service.operations()
    }

    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.execute_with_context(operation, input, cancel, ExecutionContext::default())
            .await
    }

    async fn execute_with_context(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<Value> {
        let output = self
            .service
            .execute_with_context(operation, input, cancel.clone(), context)
            .await?;
        if operation == "android.performance.start" && self.hold_start.load(Ordering::Acquire) {
            *self.session.lock().unwrap() = Some(serde_json::from_value(output).unwrap());
            self.accepted.notify_one();
            // 会话已装配，Job 仍处于返回阶段，使真实 Job 取消树可以被明确取消。
            cancel.cancelled().await;
            return Err(Error::Cancelled);
        }
        Ok(output)
    }
}

pub struct Fixture {
    pub app: Arc<Application>,
    pub plugins: Arc<PluginService>,
    pub service: PerformanceService,
    pub source: Arc<Source>,
    pub host: Arc<StartHost>,
}

impl Fixture {
    pub fn new(store: Arc<dyn PerformanceStore>, capacity: usize) -> Self {
        let service =
            PerformanceService::registered(store, capacity, Some(SOURCE_ID.into())).unwrap();
        let host = Arc::new(StartHost {
            service: service.clone(),
            hold_start: AtomicBool::new(false),
            accepted: Notify::new(),
            session: Mutex::new(None),
        });
        let app = Application::new(
            Arc::new(SqliteStore::open(":memory:").unwrap()),
            vec![host.clone()],
            1,
            4,
        )
        .unwrap();
        service.bind(&app).unwrap();
        let source = Arc::new(Source::default());
        let plugins = PluginService::new(
            app.clone(),
            Arc::new(Catalog(source.clone())),
            HashSet::new(),
        );
        Self {
            app,
            plugins,
            service,
            source,
            host,
        }
    }

    pub async fn close(&self) {
        self.service.shutdown().await.unwrap();
        self.plugins.close();
        self.plugins.wait().await;
        self.app.shutdown().await.unwrap();
    }
}

pub async fn wait_session(
    service: &PerformanceService,
    id: &str,
    condition: impl Fn(&PerformanceSession) -> bool,
) -> PerformanceSession {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match service.get(id.into()).await {
                Ok(session) if condition(&session) => return session,
                Ok(_) | Err(Error::NotFound(_)) => {}
                Err(error) => panic!("等待性能会话失败：{error}"),
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

pub async fn wait_plugin(
    plugins: &PluginService,
    condition: impl Fn(&apk_domain::plugins::PluginInfo) -> bool,
) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if plugins.list().iter().any(&condition) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
