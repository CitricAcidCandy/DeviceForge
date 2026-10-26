use super::*;
use apk_domain::devices::*;
use futures_util::poll;
use std::sync::atomic::AtomicBool;

struct PendingDeviceSource {
    calls: AtomicUsize,
    dropped: Arc<AtomicBool>,
}

struct SampleResource(Arc<AtomicBool>);
impl Drop for SampleResource {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[async_trait]
impl Executor for PendingDeviceSource {
    fn operations(&self) -> Vec<Operation> {
        DeviceSource::default().operations()
    }
    fn device_provider(&self) -> Option<DeviceProviderDefinition> {
        DeviceSource::default().device_provider()
    }
    fn performance_source(&self) -> Option<PerformanceSourceDefinition> {
        DeviceSource::default().performance_source()
    }
    async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> Result<Value> {
        panic!("待丢弃采样必须沿执行上下文调用");
    }
    async fn execute_with_context(
        &self,
        _: &str,
        _: Value,
        _: CancellationToken,
        _: ExecutionContext,
    ) -> Result<Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let _resource = SampleResource(self.dropped.clone());
        std::future::pending().await
    }
}

struct BarrierReleaseProbe {
    owner: Arc<crate::registry::Owner>,
    wakes: AtomicUsize,
    saw_risk: AtomicBool,
}
impl std::task::Wake for BarrierReleaseProbe {
    fn wake(self: Arc<Self>) {
        std::task::Wake::wake_by_ref(&self);
    }
    fn wake_by_ref(self: &Arc<Self>) {
        // 唤醒发生在物理屏障释放时，直接观察风险，避免事后检查掩盖顺序错误。
        self.saw_risk
            .store(self.owner.info().cleanup_failed, Ordering::SeqCst);
        self.wakes.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct DeviceSource(Source);
#[async_trait]
impl Executor for DeviceSource {
    fn operations(&self) -> Vec<Operation> {
        vec![
            Operation {
                id: "plugin.source.discover".into(),
                title: "发现模拟设备".into(),
                execution: None,
                input_schema: json!({"type":"object","additionalProperties":false}),
            },
            Operation {
                id: "plugin.source.sample".into(),
                title: "模拟设备采样".into(),
                execution: None,
                input_schema: json!({"type":"object","additionalProperties":false,
                    "required":["device_id","input"],"properties":{
                        "device_id":{"type":"string"},"input":{"type":"object",
                            "additionalProperties":false,"required":["package"],
                            "properties":{"package":{"type":"string"}}}}}),
            },
        ]
    }
    fn device_provider(&self) -> Option<DeviceProviderDefinition> {
        Some(DeviceProviderDefinition {
            api_version: 3,
            platform: "fixture".into(),
            discover_operation: "plugin.source.discover".into(),
            capabilities: vec![DeviceCapability {
                id: "performance.sample".into(),
                version: 1,
                operation: "plugin.source.sample".into(),
                scope: CapabilityScope::Device,
                access: CapabilityAccess::Read,
                execution_timeout_ms: Some(1000),
            }],
        })
    }
    fn performance_source(&self) -> Option<PerformanceSourceDefinition> {
        Some(PerformanceSourceDefinition {
            api_version: 2,
            operation: "plugin.source.sample".into(),
            fps: false,
            device_observation: false,
            partial_metrics: false,
            device_capability: Some(PerformanceDeviceCapability {
                id: "performance.sample".into(),
                version: 1,
            }),
        })
    }
    async fn execute(&self, _: &str, _: Value, _: CancellationToken) -> Result<Value> {
        panic!("设备采样必须沿执行上下文调用");
    }
    async fn execute_with_context(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<Value> {
        assert_eq!(
            input,
            json!({"device_id":"device","input":{"package":"com.example.app"}})
        );
        self.0
            .execute_with_context(
                operation,
                json!({"device_id":input["device_id"],"package":input["input"]["package"]}),
                cancel,
                context,
            )
            .await
    }
}

fn fixture() -> (Arc<Application>, Arc<DeviceSource>, SourceAccess) {
    let application = app();
    let executor = Arc::new(DeviceSource::default());
    application
        .registry
        .publish(
            crate::registry::Prepared::new(PluginContribution {
                id: "source".into(),
                version: "1".into(),
                executor: executor.clone(),
            })
            .unwrap(),
        )
        .unwrap();
    let access = access(&application);
    (application, executor, access)
}
fn observe(application: &Application, state: DeviceState, version: u32, available: bool) {
    let provider = application.registry.providers().pop().unwrap();
    application
        .registry
        .publish_directory(
            DeviceDirectory {
                devices: vec![ProvidedDevice {
                    reference: DeviceRef {
                        provider_id: provider.id.clone(),
                        generation: provider.generation.clone(),
                        local_id: "device".into(),
                    },
                    state,
                    raw_state: None,
                    model: None,
                    capabilities: vec![CapabilityAvailability {
                        id: "performance.sample".into(),
                        version,
                        available,
                        reason: None,
                    }],
                }],
                provider,
                observed_at: apk_domain::now(),
                discovery_job_id: "fixture".into(),
            },
            &CancellationToken::new(),
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
}

#[tokio::test]
async fn device_source_requires_current_online_device_and_exact_available_capability() {
    let (application, executor, access) = fixture();
    let cancel = CancellationToken::new();
    assert!(matches!(
        access.admit(&target(), &cancel, None),
        Err(Error::Conflict(_))
    ));
    observe(&application, DeviceState::Offline, 1, true);
    assert!(matches!(
        access.admit(&target(), &cancel, None),
        Err(Error::Conflict(_))
    ));
    observe(&application, DeviceState::Online, 2, true);
    assert!(matches!(
        access.admit(&target(), &cancel, None),
        Err(Error::Conflict(_))
    ));
    observe(&application, DeviceState::Online, 1, false);
    assert!(matches!(
        access.admit(&target(), &cancel, None),
        Err(Error::Conflict(_))
    ));
    observe(&application, DeviceState::Online, 1, true);
    let (binding, _token) = access.admit(&target(), &cancel, None).unwrap();
    assert_eq!(
        binding.reference.device.as_ref().unwrap().provider_id,
        "source"
    );
    assert_eq!(
        binding.reference.device.as_ref().unwrap().generation,
        binding.reference.generation
    );
    binding
        .sample(
            &access,
            cancel,
            binding.deadline(Instant::now(), Instant::now() + Duration::from_secs(10)),
        )
        .await
        .unwrap();
    assert_eq!(executor.0.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn reads_share_device_write_but_wait_provider_write_and_recheck_directory_and_budget() {
    let (application, executor, access) = fixture();
    observe(&application, DeviceState::Online, 1, true);
    let cancel = CancellationToken::new();
    let (binding, _token) = access.admit(&target(), &cancel, None).unwrap();
    let device_write = application
        .device_locks
        .selection(
            "source",
            Some("device"),
            &CapabilityScope::Device,
            &CapabilityAccess::Write,
        )
        .unwrap()
        .acquire(&cancel)
        .await
        .unwrap();
    binding
        .sample(
            &access,
            cancel.clone(),
            binding.deadline(Instant::now(), Instant::now() + Duration::from_secs(10)),
        )
        .await
        .unwrap();
    assert_eq!(executor.0.calls.load(Ordering::SeqCst), 1);
    drop(device_write);

    let provider_write = application
        .device_locks
        .selection(
            "source",
            None,
            &CapabilityScope::Provider,
            &CapabilityAccess::Write,
        )
        .unwrap()
        .acquire(&cancel)
        .await
        .unwrap();
    let deadline = binding.deadline(Instant::now(), Instant::now() + Duration::from_secs(10));
    assert_eq!(deadline, Instant::now() + Duration::from_secs(1));
    let sample = binding.sample(&access, cancel.clone(), deadline);
    tokio::pin!(sample);
    assert!(poll!(&mut sample).is_pending());
    observe(&application, DeviceState::Offline, 1, true);
    drop(provider_write);
    assert!(matches!(sample.await, Err(Error::Conflict(_))));
    assert_eq!(executor.0.calls.load(Ordering::SeqCst), 1);

    observe(&application, DeviceState::Online, 1, true);
    let _provider_write = application
        .device_locks
        .selection(
            "source",
            None,
            &CapabilityScope::Provider,
            &CapabilityAccess::Write,
        )
        .unwrap()
        .acquire(&cancel)
        .await
        .unwrap();
    let deadline = binding.deadline(Instant::now(), Instant::now() + Duration::from_secs(10));
    let sample = binding.sample(&access, cancel, deadline);
    tokio::pin!(sample);
    assert!(poll!(&mut sample).is_pending());
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(matches!(sample.await, Err(Error::Timeout)));
    assert_eq!(executor.0.calls.load(Ordering::SeqCst), 1);
    assert!(!binding.owner.info().cleanup_failed);
}

#[tokio::test(start_paused = true)]
async fn dropping_a_polled_sample_keeps_warning_but_next_sample_can_execute() {
    let application = app();
    let dropped = Arc::new(AtomicBool::new(false));
    let executor = Arc::new(PendingDeviceSource {
        calls: AtomicUsize::new(0),
        dropped: dropped.clone(),
    });
    application
        .registry
        .publish(
            crate::registry::Prepared::new(PluginContribution {
                id: "source".into(),
                version: "1".into(),
                executor: executor.clone(),
            })
            .unwrap(),
        )
        .unwrap();
    let access = access(&application);
    observe(&application, DeviceState::Online, 1, true);
    let cancel = CancellationToken::new();
    let (binding, _token) = access.admit(&target(), &cancel, None).unwrap();
    let deadline = binding.deadline(Instant::now(), Instant::now() + Duration::from_secs(10));
    let mut sample = Box::pin(binding.sample(&access, cancel.clone(), deadline));
    assert!(poll!(sample.as_mut()).is_pending());
    assert_eq!(executor.calls.load(Ordering::SeqCst), 1);
    assert!(!dropped.load(Ordering::SeqCst));
    assert!(!binding.owner.info().cleanup_failed);

    let release = Arc::new(BarrierReleaseProbe {
        owner: binding.owner.clone(),
        wakes: AtomicUsize::new(0),
        saw_risk: AtomicBool::new(false),
    });
    let waker = std::task::Waker::from(release.clone());
    let mut context = std::task::Context::from_waker(&waker);
    let selection = application
        .device_locks
        .selection(
            "source",
            None,
            &CapabilityScope::Provider,
            &CapabilityAccess::Write,
        )
        .unwrap();
    let mut write = Box::pin(selection.acquire(&cancel));
    // 真实 provider/write 等候者必须先被采样读屏障阻挡。
    assert!(std::future::Future::poll(write.as_mut(), &mut context).is_pending());
    assert_eq!(release.wakes.load(Ordering::SeqCst), 0);
    drop(sample);
    assert!(dropped.load(Ordering::SeqCst));
    assert!(release.wakes.load(Ordering::SeqCst) > 0);
    assert!(release.saw_risk.load(Ordering::SeqCst));
    let physical_guard = tokio::time::timeout(Duration::from_secs(1), write)
        .await
        .unwrap()
        .unwrap();
    assert!(binding.owner.info().cleanup_failed);
    // 历史风险不占有设备锁；本次仍取得真实互斥后独立执行。
    assert!(!executor.has_unresolved_resources());
    drop(physical_guard);
    let mut next = Box::pin(binding.sample(&access, cancel, deadline));
    assert!(poll!(next.as_mut()).is_pending());
    assert_eq!(executor.calls.load(Ordering::SeqCst), 2);
    drop(next);
    assert!(binding.owner.info().cleanup_failed);
}
