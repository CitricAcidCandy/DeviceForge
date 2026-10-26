//! 公开资源描述、完整性与真实进程退出共同约束仓库租约的释放。
use super::*;
use deviceforge_tool_repository::ToolKey;
use serde_json::{Value, json};
use std::{fs, time::Duration};

// acquire 的受限工作池为生产稳定性边界；这里串行验证行为，避免测试争抢名额。
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Fixture {
    _temporary: tempfile::TempDir,
    repository: Repository,
    resources: std::path::PathBuf,
    marker: std::path::PathBuf,
    entry: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let repository = Repository::open(&temporary.path().join("tools")).unwrap();
        let key = ToolKey {
            id: "runtime".into(),
            version: "1.0.0".into(),
            platform: Repository::platform(),
            sha256: "a".repeat(64),
        };
        let stage = repository.stage().unwrap();
        let payload = stage.path().join("payload");
        fs::create_dir(&payload).unwrap();
        fs::write(payload.join("runtime.bin"), b"tool").unwrap();
        let content = repository
            .write()
            .unwrap()
            .publish(&key, &payload, &|| Ok(()))
            .unwrap();
        let fixture = Self {
            resources: temporary.path().join("resources.json"),
            marker: temporary.path().join("child-started"),
            entry: content.join("runtime.bin"),
            repository,
            _temporary: temporary,
        };
        fixture.write(fixture.value());
        fixture
    }
    fn value(&self) -> Value {
        json!({"format_version":1,"release_id":"test","revision":"a".repeat(64),
            "repository":{"format_version":1,"root":self.repository.root(),"client_id":"test"},
            "tools":{"runtime":{"version":"1.0.0","platform":Repository::platform(),"entries":{"main":self.entry}}}})
    }
    fn write(&self, value: Value) {
        fs::write(&self.resources, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    async fn acquire(&self) -> Result<Arc<ToolLease>> {
        self.acquire_for(&Arc::new(AtomicBool::new(false))).await
    }
    async fn acquire_for(&self, unresolved: &Arc<AtomicBool>) -> Result<Arc<ToolLease>> {
        acquire(
            Some(&self.resources),
            &CancellationToken::new(),
            Instant::now() + Duration::from_secs(5),
            unresolved,
        )
        .await
    }
}

#[path = "plugin_resources/recovery_tests.rs"]
mod recovery_tests;

#[tokio::test]
async fn external_dependencies_validate_without_taking_repository_read_lock() {
    let _serial = SERIAL.lock().await;
    let fixture = Fixture::new();
    let mut value = fixture.value();
    value["managed_tools"] = json!({});
    fixture.write(value);
    let writer = fixture.repository.write().unwrap();
    let lease = fixture.acquire().await.unwrap();
    assert!(lease.reader.is_none());
    drop(writer);
    fs::remove_file(&fixture.entry).unwrap();
    assert!(
        matches!(fixture.acquire().await, Err(Error::Dependency(message))
        if message.contains("外部依赖工具入口已失效"))
    );
}

#[tokio::test]
async fn mixed_dependencies_verify_package_revision_instead_of_runtime_version() {
    let _serial = SERIAL.lock().await;
    let fixture = Fixture::new();
    let external = fixture._temporary.path().join("external.exe");
    fs::write(&external, b"external").unwrap();
    let mut value = fixture.value();
    value["managed_tools"] = json!({"runtime":"1.0.0"});
    value["tools"]["runtime"]["version"] = json!("1.0.0.5");
    value["tools"]["external"] =
        json!({"version":"2.0.0","platform":Repository::platform(),"entries":{"main":external}});
    fixture.write(value);
    let lease = fixture.acquire().await.unwrap();
    assert!(lease.reader.is_some());
    assert!(matches!(
        fixture.repository.write(),
        Err(deviceforge_tool_repository::Error::Busy)
    ));
    drop(lease);
    fixture.repository.write().unwrap();
}

#[tokio::test]
async fn managed_acquire_waits_before_read_lease_and_unmanaged_calls_bypass_full_pool() {
    let _serial = SERIAL.lock().await;
    let fixture = Fixture::new();
    let pool = validation_pool();
    let occupied = pool.workers.clone().acquire_many_owned(2).await.unwrap();
    let mut waiting = Box::pin(fixture.acquire());
    assert!(futures_util::poll!(&mut waiting).is_pending());
    assert_eq!(pool.waiters.available_permits(), 7);
    fixture.repository.write().unwrap();
    let queued = pool.waiters.clone().acquire_many_owned(7).await.unwrap();
    let unmanaged = acquire(
        None,
        &CancellationToken::new(),
        Instant::now() + Duration::from_secs(5),
        &Arc::new(AtomicBool::new(false)),
    )
    .await
    .unwrap();
    assert!(unmanaged.reader.is_none());
    drop(queued);
    drop(occupied);
    let lease = waiting.await.unwrap();
    assert!(matches!(
        fixture.repository.write(),
        Err(deviceforge_tool_repository::Error::Busy)
    ));
    drop(lease);
    fixture.repository.write().unwrap();
    assert_eq!(pool.workers.available_permits(), 2);
    assert_eq!(pool.waiters.available_permits(), 8);
}

#[tokio::test]
async fn validation_queue_is_bounded_and_dropping_waiters_restores_capacity() {
    let pool = ValidationPool::new();
    let cancel = CancellationToken::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    let occupied = pool.workers.clone().acquire_many_owned(2).await.unwrap();
    let mut waiting = Vec::new();
    for _ in 0..8 {
        let mut future = Box::pin(pool.acquire(&cancel, deadline));
        assert!(futures_util::poll!(&mut future).is_pending());
        waiting.push(future);
    }
    assert!(matches!(
        pool.acquire(&cancel, deadline).await,
        Err(Error::Conflict(message)) if message == "工具资源校验等待队列已满"
    ));
    drop(waiting.pop());
    assert_eq!(pool.waiters.available_permits(), 1);
    let mut replacement = Box::pin(pool.acquire(&cancel, deadline));
    assert!(futures_util::poll!(&mut replacement).is_pending());
    drop(replacement);
    drop(waiting);
    drop(occupied);
    assert_eq!(pool.workers.available_permits(), 2);
    assert_eq!(pool.waiters.available_permits(), 8);
}

#[tokio::test(start_paused = true)]
async fn validation_waiting_consumes_original_deadline_and_responds_to_cancel() {
    let pool = ValidationPool::new();
    let occupied = pool.workers.clone().acquire_many_owned(2).await.unwrap();
    for expired in [false, true] {
        let cancel = CancellationToken::new();
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut waiting = Box::pin(pool.acquire(&cancel, deadline));
        assert!(futures_util::poll!(&mut waiting).is_pending());
        if expired {
            tokio::time::advance(Duration::from_secs(1)).await;
            assert!(matches!(waiting.await, Err(Error::Timeout)));
        } else {
            cancel.cancel();
            assert!(matches!(waiting.await, Err(Error::Cancelled)));
        }
        assert_eq!(pool.waiters.available_permits(), 8);
        assert_eq!(pool.workers.available_permits(), 0);
    }
    drop(occupied);
    let permit = pool
        .acquire(
            &CancellationToken::new(),
            Instant::now() + Duration::from_secs(1),
        )
        .await
        .unwrap();
    drop(permit);
    assert_eq!(pool.workers.available_permits(), 2);
}

#[tokio::test]
async fn cancelled_or_dropped_validation_keeps_worker_and_read_lease_until_work_finishes() {
    for abort in [false, true] {
        let fixture = Fixture::new();
        let pool = Arc::new(ValidationPool::new());
        let occupied = pool.workers.clone().acquire_owned().await.unwrap();
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, resume) = std::sync::mpsc::channel();
        let cancel = CancellationToken::new();
        let running_cancel = cancel.clone();
        let running_pool = pool.clone();
        let root = fixture.repository.root().to_owned();
        let invocation = tokio::spawn(async move {
            running_pool
                .work(
                    &running_cancel,
                    Instant::now() + Duration::from_secs(5),
                    move || {
                        let repository = Repository::open(&root).map_err(shared_error)?;
                        let _reader = repository.read().map_err(shared_error)?;
                        entered.send(()).unwrap();
                        resume.recv_timeout(Duration::from_secs(5)).unwrap();
                        Ok(())
                    },
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), ready)
            .await
            .unwrap()
            .unwrap();
        if abort {
            invocation.abort();
            assert!(invocation.await.unwrap_err().is_cancelled());
        } else {
            cancel.cancel();
            assert!(matches!(invocation.await.unwrap(), Err(Error::Cancelled)));
        }
        assert_eq!(pool.workers.available_permits(), 0);
        assert_eq!(pool.waiters.available_permits(), 8);
        assert!(matches!(
            fixture.repository.write(),
            Err(deviceforge_tool_repository::Error::Busy)
        ));
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while pool.workers.available_permits() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        fixture.repository.write().unwrap();
        drop(occupied);
        assert_eq!(pool.workers.available_permits(), 2);
    }
}

#[tokio::test]
async fn supplier_without_tool_bindings_does_not_hold_repository_read_lock() {
    let _serial = SERIAL.lock().await;
    let fixture = Fixture::new();
    let mut value = fixture.value();
    value["tools"] = json!({});
    fixture.write(value);
    let lease = fixture.acquire().await.unwrap();
    fixture.repository.write().unwrap();
    drop(lease);
}

#[tokio::test]
async fn bound_entry_holds_lease_until_all_resource_owners_drop() {
    let _serial = SERIAL.lock().await;
    let fixture = Fixture::new();
    let first = fixture.acquire().await.unwrap();
    let process = first.clone();
    assert!(matches!(
        fixture.repository.write(),
        Err(deviceforge_tool_repository::Error::Busy)
    ));
    drop(first);
    assert!(matches!(
        fixture.repository.write(),
        Err(deviceforge_tool_repository::Error::Busy)
    ));
    drop(process);
    fixture.repository.write().unwrap();
}

#[tokio::test]
async fn identity_empty_entries_and_modified_content_are_rejected_before_execution() {
    let _serial = SERIAL.lock().await;
    let fixture = Fixture::new();
    for field in ["version", "platform"] {
        let mut value = fixture.value();
        value["tools"]["runtime"][field] = "different".into();
        fixture.write(value);
        assert!(matches!(fixture.acquire().await, Err(Error::Invalid(_))));
        fixture.repository.write().unwrap();
    }
    let mut value = fixture.value();
    value["tools"]["runtime"]["entries"] = json!({});
    fixture.write(value);
    assert!(matches!(fixture.acquire().await, Err(Error::Invalid(_))));
    fixture.write(fixture.value());
    fs::write(&fixture.entry, b"changed").unwrap();
    assert!(matches!(fixture.acquire().await, Err(Error::Invalid(_))));
    fixture.repository.write().unwrap();
}

#[test]
fn child_process_waits_until_terminated_by_its_owner() {
    if let Some(path) = std::env::var_os("DEVICEFORGE_REPOSITORY_CHILD_MARKER") {
        fs::write(path, std::process::id().to_string()).unwrap();
        std::thread::sleep(Duration::from_secs(30));
    }
}

#[tokio::test]
async fn real_process_cancellation_and_dropped_waiter_keep_lease_until_reaped() {
    let _serial = SERIAL.lock().await;
    for abort in [false, true] {
        let fixture = Fixture::new();
        let lease = fixture.acquire().await.unwrap();
        let cancel = CancellationToken::new();
        let process_cancel = cancel.clone();
        let marker = fixture.marker.clone();
        let process = tokio::spawn(async move {
            let executable = std::env::current_exe().unwrap();
            let args = vec![
                "--exact".into(),
                "plugin_resources::tests::child_process_waits_until_terminated_by_its_owner".into(),
                "--nocapture".into(),
            ];
            let mut command =
                deviceforge_tool_process::ToolCommand::new(executable.to_str().unwrap(), &args);
            command.env.insert(
                "DEVICEFORGE_REPOSITORY_CHILD_MARKER".into(),
                marker.into_os_string(),
            );
            deviceforge_tool_process::capture_with_lease(
                command,
                deviceforge_tool_process::ExecutionOptions::new(
                    Instant::now() + Duration::from_secs(10),
                ),
                process_cancel,
                lease,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while !fixture.marker.exists() {
                assert!(!process.is_finished(), "真实进程应写入启动标记后保持运行");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(matches!(
            fixture.repository.write(),
            Err(deviceforge_tool_repository::Error::Busy)
        ));
        if abort {
            process.abort();
            assert!(process.await.unwrap_err().is_cancelled());
        } else {
            cancel.cancel();
            assert!(matches!(
                process.await.unwrap(),
                Err(deviceforge_tool_process::Error::Cancelled)
            ));
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match fixture.repository.write() {
                    Ok(writer) => break drop(writer),
                    Err(deviceforge_tool_repository::Error::Busy) => {
                        tokio::time::sleep(Duration::from_millis(10)).await
                    }
                    Err(error) => panic!("进程回收后仓库写锁异常：{error}"),
                }
            }
        })
        .await
        .unwrap();
    }
}
