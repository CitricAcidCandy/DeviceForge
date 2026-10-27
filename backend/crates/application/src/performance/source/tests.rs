use super::*;
use apk_domain::{ExecutionContext, Executor, Operation, plugins::PluginContribution};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

#[derive(Default)]
struct Source {
    calls: AtomicUsize,
    deadlines: Mutex<Vec<Option<std::time::Instant>>>,
}
#[async_trait]
impl Executor for Source {
    fn operations(&self) -> Vec<Operation> {
        vec![Operation {
            id: "plugin.source.sample".into(),
            title: "模拟性能来源".into(),
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
            device_observation: false,
            partial_metrics: false,
            device_capability: None,
        })
    }
    async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> Result<Value> {
        panic!("内部采样必须通过原执行上下文传播期限");
    }
    async fn execute_with_context(
        &self,
        _: &str,
        input: Value,
        _: CancellationToken,
        context: ExecutionContext,
    ) -> Result<Value> {
        assert_eq!(
            input,
            json!({"device_id":"device","package":"com.example.app"})
        );
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.deadlines.lock().unwrap().push(context.deadline);
        Ok(
            json!({"captured_at":apk_domain::now(),"pid":1,"process_start_ticks":1,
            "process_ticks":1,"system_ticks":2,"logical_cpus":1,"pss_kib":3,"rss_kib":null}),
        )
    }
}
fn app() -> Arc<Application> {
    Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        4,
    )
    .unwrap()
}
fn install(application: &Application, executor: Arc<Source>) {
    application
        .registry
        .publish(
            crate::registry::Prepared::new(PluginContribution {
                id: "source".into(),
                version: "1".into(),
                executor,
            })
            .unwrap(),
        )
        .unwrap();
}
fn target() -> PerformanceTarget {
    PerformanceTarget {
        device_id: "device".into(),
        package: "com.example.app".into(),
    }
}
fn access(application: &Arc<Application>) -> SourceAccess {
    let access = SourceAccess::new(Some("source".into())).unwrap();
    access.bind(application).unwrap();
    access
}

#[test]
fn absent_sources_and_unavailable_host_fail_without_builtin_fallback() {
    let application = app();
    let unavailable = access(&application);
    assert!(matches!(
        unavailable.capabilities(),
        Err(Error::NotFound(_))
    ));
    let absent = SourceAccess::new(None).unwrap();
    absent.bind(&application).unwrap();
    assert!(matches!(absent.capabilities(), Err(Error::NotFound(_))));
    assert!(SourceAccess::new(Some("bad id".into())).is_err());
    install(&application, Arc::new(Source::default()));
    assert_eq!(unavailable.capabilities().unwrap().source, "plugin.source");
    assert!(matches!(
        unavailable.bind(&application),
        Err(Error::Conflict(_))
    ));
    drop(application);
    assert!(matches!(
        unavailable.capabilities(),
        Err(Error::Dependency(_))
    ));
}

#[tokio::test]
async fn admission_is_tracked_and_old_binding_never_becomes_the_new_generation() {
    let application = app();
    let executor = Arc::new(Source::default());
    install(&application, executor.clone());
    let access = access(&application);
    let (binding, token) = access
        .admit(&target(), &CancellationToken::new(), None)
        .unwrap();
    assert!(binding.reference.device.is_none());
    let original = binding.reference.clone();
    let detached = application.registry.detach("source").unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(10), detached.tracker.wait())
            .await
            .is_err()
    );
    assert!(matches!(access.capabilities(), Err(Error::Conflict(_))));
    assert!(matches!(
        access.admit(&target(), &CancellationToken::new(), None),
        Err(Error::Conflict(_))
    ));
    assert!(binding.check_current(&access).is_err());
    assert!(
        binding
            .claim(&access, &CancellationToken::new(), None)
            .is_err()
    );
    assert!(matches!(
        binding.control_claim(&access, &CancellationToken::new(), None),
        Err(Error::Conflict(_))
    ));
    drop(token);
    detached.tracker.wait().await;
    application.registry.finish(&detached).unwrap();
    install(&application, executor);
    let (new, _token) = access
        .admit(&target(), &CancellationToken::new(), None)
        .unwrap();
    assert_ne!(new.reference.generation, original.generation);
    assert_eq!(binding.reference, original);
    assert!(binding.check_current(&access).is_err());
}

#[tokio::test(start_paused = true)]
async fn internal_sampling_uses_original_deadline_without_jobs_and_prechecks_zero_calls() {
    let application = app();
    let executor = Arc::new(Source::default());
    install(&application, executor.clone());
    let access = access(&application);
    let (binding, _token) = access
        .admit(&target(), &CancellationToken::new(), None)
        .unwrap();
    let inherited = Instant::now() + Duration::from_secs(3);
    let deadline = binding.deadline(Instant::now(), inherited);
    assert_eq!(deadline, inherited);
    binding
        .sample(&access, CancellationToken::new(), deadline)
        .await
        .unwrap();
    assert_eq!(
        executor.deadlines.lock().unwrap().as_slice(),
        &[Some(deadline.into_std())]
    );
    assert!(application.list(10).unwrap().is_empty());
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(matches!(
        binding.sample(&access, cancelled, deadline).await,
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        binding
            .sample(&access, CancellationToken::new(), Instant::now())
            .await,
        Err(Error::Timeout)
    ));
    assert_eq!(executor.calls.load(Ordering::SeqCst), 1);
    assert!(!binding.owner.info().cleanup_failed);
}

#[tokio::test]
async fn source_binding_does_not_retain_application_and_old_cleanup_warning_allows_claims() {
    let application = app();
    install(&application, Arc::new(Source::default()));
    let access = access(&application);
    let (binding, _token) = access
        .admit(&target(), &CancellationToken::new(), None)
        .unwrap();
    binding.owner.mark_unresolved();
    binding.check_current(&access).unwrap();
    drop(
        binding
            .claim(&access, &CancellationToken::new(), None)
            .unwrap(),
    );
    access.capabilities().unwrap();
    assert!(binding.owner.info().cleanup_failed);
    let control = binding
        .control_claim(&access, &CancellationToken::new(), None)
        .unwrap();
    drop(control);
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(matches!(
        binding.control_claim(&access, &cancelled, None),
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        binding.control_claim(&access, &CancellationToken::new(), Some(Instant::now())),
        Err(Error::Timeout)
    ));
    application.registry.detach("source").unwrap();
    assert!(access.capabilities().is_err());
    assert!(
        access
            .admit(&target(), &CancellationToken::new(), None)
            .is_err()
    );
    let weak = Arc::downgrade(&application);
    drop(application);
    assert!(weak.upgrade().is_none());
    assert!(matches!(
        binding.check_current(&access),
        Err(Error::Dependency(_))
    ));
}

mod devices;
