//! 确定性轮询、清理与风险接缝；暂停时间只证明内核排序，不代表真实工具验收。
use super::*;
use crate::registry::{Prepared, Registered, Registry};
use apk_domain::{Job, JobStatus, Operation, plugins::PluginContribution};
use async_trait::async_trait;
use futures_util::poll;
use serde_json::json;
use std::{
    future::{pending, poll_fn},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    task::Poll,
};

#[derive(Default)]
struct Echo {
    calls: AtomicUsize,
}

#[async_trait]
impl Executor for Echo {
    fn operations(&self) -> Vec<Operation> {
        vec![Operation {
            id: "plugin.test.echo".into(),
            title: "收口测试回显".into(),
            input_schema: json!({"type":"object"}),
            execution: None,
        }]
    }

    async fn execute(&self, _: &str, input: Value, _: CancellationToken) -> Result<Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(input)
    }
}

fn registered(executor: Arc<dyn Executor>) -> (Registry, Arc<Registered>) {
    let registry = Registry::new(vec![]).unwrap();
    registry
        .publish(
            Prepared::new(PluginContribution {
                id: "test".into(),
                version: "1".into(),
                executor,
            })
            .unwrap(),
        )
        .unwrap();
    let registered = registry.find("plugin.test.echo").unwrap();
    (registry, registered)
}

struct Dropped(Arc<AtomicBool>);

impl Drop for Dropped {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

async fn held(dropped: Arc<AtomicBool>) -> Result<Value> {
    let _resource = Dropped(dropped);
    pending().await
}

async fn panic_after_start(cancel: CancellationToken, during_cleanup: bool) -> Result<Value> {
    if during_cleanup {
        cancel.cancelled().await;
    }
    panic!("定向模拟执行器在已轮询后失去清理确认");
}

#[tokio::test(start_paused = true)]
async fn pre_cancelled_expired_and_same_instant_inputs_poll_nothing_and_create_no_risk() {
    let (_, entry) = registered(Arc::new(Echo::default()));
    let owner = entry.owner.as_ref().unwrap();
    for (cancelled, expired) in [(true, false), (false, true), (true, true)] {
        let cancel = CancellationToken::new();
        if cancelled {
            cancel.cancel();
        }
        let deadline = tokio::time::Instant::now()
            + if expired {
                Duration::ZERO
            } else {
                Duration::from_secs(10)
            };
        let polls = Arc::new(AtomicUsize::new(0));
        let observed = polls.clone();
        let future = poll_fn(move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
            Poll::Ready(Ok(Value::Null))
        });
        let result = settle(future, &cancel, Some(owner), Some(deadline)).await;
        if expired {
            assert!(matches!(result, Err(Error::Timeout)));
        } else {
            assert!(matches!(result, Err(Error::Cancelled)));
        }
        assert_eq!(polls.load(Ordering::SeqCst), 0);
        assert!(!owner.info().cleanup_failed);
    }
}

#[tokio::test(start_paused = true)]
async fn cooperative_cancel_keeps_first_reason_when_cleanup_crosses_business_deadline() {
    let (_, entry) = registered(Arc::new(Echo::default()));
    let owner = entry.owner.as_ref().unwrap();
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let cleaned = Arc::new(AtomicBool::new(false));
    let confirmed = cleaned.clone();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    let future = async move {
        token.cancelled().await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        confirmed.store(true, Ordering::SeqCst);
        Ok(Value::Null)
    };
    let mut work = Box::pin(settle(future, &cancel, Some(owner), Some(deadline)));
    assert!(poll!(work.as_mut()).is_pending());
    cancel.cancel();
    assert!(poll!(work.as_mut()).is_pending());
    tokio::time::advance(Duration::from_millis(1500)).await;
    assert!(matches!(work.await, Err(Error::Cancelled)));
    assert!(tokio::time::Instant::now() > deadline);
    assert!(cleaned.load(Ordering::SeqCst));
    assert!(!owner.info().cleanup_failed);
}

#[tokio::test(start_paused = true)]
async fn cooperative_deadline_requests_cancel_and_confirms_cleanup_without_risk() {
    let (_, entry) = registered(Arc::new(Echo::default()));
    let owner = entry.owner.as_ref().unwrap();
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let cleaned = Arc::new(AtomicBool::new(false));
    let confirmed = cleaned.clone();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    let future = async move {
        token.cancelled().await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        confirmed.store(true, Ordering::SeqCst);
        Err::<Value, _>(Error::Cancelled)
    };
    let mut work = Box::pin(settle(future, &cancel, Some(owner), Some(deadline)));
    assert!(poll!(work.as_mut()).is_pending());
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(poll!(work.as_mut()).is_pending());
    assert!(cancel.is_cancelled());
    tokio::time::advance(Duration::from_millis(1500)).await;
    assert!(matches!(work.await, Err(Error::Timeout)));
    assert!(cleaned.load(Ordering::SeqCst));
    assert!(!owner.info().cleanup_failed);
}

#[tokio::test(start_paused = true)]
async fn cleanup_window_exhaustion_keeps_warning_but_allows_next_independent_execution() {
    let executor = Arc::new(Echo::default());
    let (registry, entry) = registered(executor.clone());
    let owner = entry.owner.as_ref().unwrap();
    let cancel = CancellationToken::new();
    let dropped = Arc::new(AtomicBool::new(false));
    let mut work = Box::pin(settle(held(dropped.clone()), &cancel, Some(owner), None));
    assert!(poll!(work.as_mut()).is_pending());
    cancel.cancel();
    assert!(poll!(work.as_mut()).is_pending());
    tokio::time::advance(Duration::from_millis(1999)).await;
    assert!(poll!(work.as_mut()).is_pending());
    assert!(!dropped.load(Ordering::SeqCst));
    tokio::time::advance(Duration::from_millis(1)).await;
    assert!(matches!(work.await, Err(Error::CleanupFailed)));
    assert!(dropped.load(Ordering::SeqCst));
    // 替身本身没有未确认位，风险须由应用owner保持，不能靠Future析构解除。
    assert!(!executor.has_unresolved_resources());
    assert!(owner.info().cleanup_failed);
    assert!(
        execute(
            executor.as_ref(),
            &entry.operation.id,
            json!({}),
            CancellationToken::new(),
            Some(owner),
            None
        )
        .await
        .is_ok()
    );
    assert_eq!(executor.calls.load(Ordering::SeqCst), 1);
    let detached = registry.detach("test").unwrap();
    assert!(registry.finish(&detached).unwrap().cleanup_failed);
    assert!(owner.info().cleanup_failed);
}

#[tokio::test]
async fn panic_during_execution_or_cleanup_sets_the_same_owner_risk() {
    for during_cleanup in [false, true] {
        let (_, entry) = registered(Arc::new(Echo::default()));
        let owner = entry.owner.as_ref().unwrap();
        let cancel = CancellationToken::new();
        let mut work = Box::pin(settle(
            panic_after_start(cancel.clone(), during_cleanup),
            &cancel,
            Some(owner),
            None,
        ));
        if during_cleanup {
            assert!(poll!(work.as_mut()).is_pending());
            cancel.cancel();
        }
        assert!(matches!(work.await, Err(Error::CleanupFailed)));
        assert!(owner.info().cleanup_failed);
    }
}

#[tokio::test]
async fn dropping_a_polled_settle_future_marks_owner_before_releasing_work() {
    struct RiskOnDrop(Arc<Owner>, Arc<AtomicBool>);
    impl Drop for RiskOnDrop {
        fn drop(&mut self) {
            self.1.store(self.0.info().cleanup_failed, Ordering::SeqCst);
        }
    }
    let (_, entry) = registered(Arc::new(Echo::default()));
    let owner = entry.owner.as_ref().unwrap();
    let cancel = CancellationToken::new();
    let dropped = Arc::new(AtomicBool::new(false));
    let saw_risk = Arc::new(AtomicBool::new(false));
    let resource_owner = owner.clone();
    let observed = saw_risk.clone();
    let released = dropped.clone();
    let future = async move {
        let _resource = RiskOnDrop(resource_owner, observed);
        let _dropped = Dropped(released);
        pending::<Result<Value>>().await
    };
    let mut work = Box::pin(settle(future, &cancel, Some(owner), None));
    assert!(poll!(work.as_mut()).is_pending());
    assert!(!owner.info().cleanup_failed);
    drop(work);
    assert!(dropped.load(Ordering::SeqCst));
    assert!(saw_risk.load(Ordering::SeqCst));
    assert!(owner.info().cleanup_failed);
    cancel.cancel();
    let polls = AtomicUsize::new(0);
    let future = poll_fn(|_| {
        polls.fetch_add(1, Ordering::SeqCst);
        Poll::Ready(Ok(Value::Null))
    });
    assert!(matches!(
        settle(future, &cancel, Some(owner), None).await,
        Err(Error::Cancelled)
    ));
    assert_eq!(polls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cancellation_between_admission_and_first_poll_never_starts_work_for_cleanup() {
    struct CancellingProbe {
        cancel: CancellationToken,
        enabled: AtomicBool,
    }
    #[async_trait]
    impl Executor for CancellingProbe {
        fn operations(&self) -> Vec<Operation> {
            Echo::default().operations()
        }
        fn has_unresolved_resources(&self) -> bool {
            if self.enabled.swap(false, Ordering::SeqCst) {
                self.cancel.cancel();
            }
            false
        }
        async fn execute(&self, _: &str, input: Value, _: CancellationToken) -> Result<Value> {
            Ok(input)
        }
    }
    let cancel = CancellationToken::new();
    let probe = Arc::new(CancellingProbe {
        cancel: cancel.clone(),
        enabled: AtomicBool::new(false),
    });
    let (_, entry) = registered(probe.clone());
    let owner = entry.owner.as_ref().unwrap();
    // 取消独立于历史诊断查询；执行前撤销仍不能首次轮询业务。
    cancel.cancel();
    let polls = AtomicUsize::new(0);
    let future = poll_fn(|_| {
        polls.fetch_add(1, Ordering::SeqCst);
        Poll::Ready(Ok(Value::Null))
    });
    assert!(matches!(
        settle(future, &cancel, Some(owner), None).await,
        Err(Error::Cancelled)
    ));
    assert_eq!(polls.load(Ordering::SeqCst), 0);
    assert!(!owner.info().cleanup_failed);
}

#[tokio::test]
async fn explicit_cleanup_failure_stays_typed_and_marks_application_owner() {
    let executor = Arc::new(Echo::default());
    let (_, entry) = registered(executor.clone());
    let owner = entry.owner.as_ref().unwrap();
    let cancel = CancellationToken::new();
    assert!(matches!(
        settle(
            async { Err::<Value, _>(Error::CleanupFailed) },
            &cancel,
            Some(owner),
            None
        )
        .await,
        Err(Error::CleanupFailed)
    ));
    assert!(!executor.has_unresolved_resources());
    assert!(owner.info().cleanup_failed);
}

#[tokio::test(start_paused = true)]
async fn unowned_executors_keep_success_panic_and_unconfirmed_cancel_compatibility() {
    let cancel = CancellationToken::new();
    assert_eq!(
        settle(async { Ok(json!({"kept":true})) }, &cancel, None, None)
            .await
            .unwrap(),
        json!({"kept":true})
    );
    assert!(
        matches!(settle(panic_after_start(cancel.clone(), false), &cancel, None, None).await,
        Err(Error::Dependency(message)) if message == "执行器发生内部异常")
    );
    let dropped = Arc::new(AtomicBool::new(false));
    let mut work = Box::pin(settle(held(dropped.clone()), &cancel, None, None));
    assert!(poll!(work.as_mut()).is_pending());
    cancel.cancel();
    assert!(poll!(work.as_mut()).is_pending());
    tokio::time::advance(Duration::from_secs(2)).await;
    assert!(matches!(work.await, Err(Error::Cancelled)));
    assert!(dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn queued_ordinary_runner_rechecks_owner_after_worker_wait_before_running() {
    let executor = Arc::new(Echo::default());
    let app = crate::Application::new(
        Arc::new(apk_infrastructure::store::SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        4,
    )
    .unwrap();
    app.registry
        .publish(
            Prepared::new(PluginContribution {
                id: "test".into(),
                version: "1".into(),
                executor: executor.clone(),
            })
            .unwrap(),
        )
        .unwrap();
    let entry = app.registry.find("plugin.test.echo").unwrap();
    let owner = entry.owner.as_ref().unwrap();
    let job = Job {
        id: uuid::Uuid::new_v4().to_string(),
        operation: entry.operation.id.clone(),
        input: json!({}),
        status: JobStatus::Queued,
        result: None,
        error: None,
        created_at: apk_domain::now(),
    };
    app.store.create(&job).unwrap();
    let plan = crate::alias_plan::Plan::new(&entry, &job.input).unwrap();
    let permit = app.workers.acquire().await.unwrap();
    let mut work = Box::pin(app.run(
        &job,
        plan,
        CancellationToken::new(),
        crate::runner::Admission {
            selection: None,
            deadline: None,
            discovery: None,
            completion: crate::completion::Completion::new(),
        },
    ));
    // 手工首次poll实际进入被占满的worker队列，再注入其它任务遗留的风险。
    assert!(poll!(work.as_mut()).is_pending());
    assert_eq!(app.get(&job.id).unwrap().status, JobStatus::Queued);
    owner.mark_unresolved();
    drop(permit);
    work.await.unwrap();
    assert_eq!(executor.calls.load(Ordering::SeqCst), 1);
    assert_eq!(app.get(&job.id).unwrap().status, JobStatus::Succeeded);
    assert!(owner.info().cleanup_failed);
}
