//! 通知测试使用内存 SQLite 核对已提交状态，不创建文件或后台任务。

use crate::job_notifications::NotifyingJobStore;
use apk_domain::{Error, Job, JobEvent, JobProgress, JobStage, JobStatus, JobStore, Result};
use apk_infrastructure::store::SqliteStore;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::watch;

fn job(id: &str) -> Job {
    Job {
        id: id.into(),
        operation: "test.notifications".into(),
        input: json!({}),
        status: JobStatus::Queued,
        result: None,
        error: None,
        created_at: 0,
    }
}

fn fixture() -> (Arc<SqliteStore>, NotifyingJobStore, watch::Receiver<u64>) {
    let inner = Arc::new(SqliteStore::open(":memory:").unwrap());
    let store = NotifyingJobStore::new(inner.clone());
    let changes = store.subscribe();
    (inner, store, changes)
}

fn committed(changes: &mut watch::Receiver<u64>, revision: u64) {
    assert!(changes.has_changed().unwrap());
    assert_eq!(*changes.borrow_and_update(), revision);
    quiet(changes, revision);
}

fn quiet(changes: &watch::Receiver<u64>, revision: u64) {
    assert_eq!(*changes.borrow(), revision);
    assert!(!changes.has_changed().unwrap());
}

#[test]
fn committed_create_transition_progress_and_recover_publish_once() {
    let (inner, store, mut changes) = fixture();
    quiet(&changes, 0);

    store.create(&job("committed")).unwrap();
    assert_eq!(inner.get("committed").unwrap().status, JobStatus::Queued);
    assert_eq!(inner.events("committed", 0).unwrap().len(), 1);
    committed(&mut changes, 1);

    let running = store
        .transition("committed", JobStatus::Running, None, None)
        .unwrap();
    assert_eq!(running.status, JobStatus::Running);
    assert_eq!(inner.get("committed").unwrap().status, JobStatus::Running);
    committed(&mut changes, 2);

    store
        .progress(
            "committed",
            JobProgress {
                stage: JobStage::Downloading,
                resource_id: Some("test.resource".into()),
                completed_bytes: 20,
                total_bytes: Some(100),
            },
        )
        .unwrap();
    let events = inner.events("committed", 0).unwrap();
    let progress = events.last().unwrap().progress.as_ref().unwrap();
    assert_eq!(progress.completed_bytes, 20);
    assert_eq!(progress.total_bytes, Some(100));
    assert_eq!(inner.get("committed").unwrap().status, JobStatus::Running);
    committed(&mut changes, 3);

    store.recover().unwrap();
    let recovered = inner.get("committed").unwrap();
    assert_eq!(recovered.status, JobStatus::Failed);
    assert!(recovered.error.is_some());
    assert_eq!(inner.events("committed", 0).unwrap().len(), 4);
    committed(&mut changes, 4);
}

#[test]
fn failed_create_does_not_publish_or_replace_persisted_job() {
    let (inner, store, mut changes) = fixture();
    store.create(&job("duplicate")).unwrap();
    committed(&mut changes, 1);

    let mut duplicate = job("duplicate");
    duplicate.input = json!({"replacement": true});
    assert!(matches!(store.create(&duplicate), Err(Error::Storage(_))));
    quiet(&changes, 1);
    assert_eq!(inner.get("duplicate").unwrap().input, json!({}));
    assert_eq!(inner.events("duplicate", 0).unwrap().len(), 1);

    store.create(&job("independent")).unwrap();
    committed(&mut changes, 2);
    assert_eq!(inner.list(10).unwrap().len(), 2);
}

#[test]
fn failed_transition_and_progress_keep_revision_and_persisted_state() {
    let (inner, store, mut changes) = fixture();
    store.create(&job("queued")).unwrap();
    committed(&mut changes, 1);

    assert!(matches!(
        store.transition("queued", JobStatus::Succeeded, Some(json!(true)), None),
        Err(Error::Conflict(_))
    ));
    quiet(&changes, 1);
    assert!(matches!(
        store.transition("missing", JobStatus::Running, None, None),
        Err(Error::NotFound(_))
    ));
    quiet(&changes, 1);
    assert!(matches!(
        store.progress("missing", JobProgress::stage(JobStage::Preparing)),
        Err(Error::NotFound(_))
    ));
    quiet(&changes, 1);
    assert!(matches!(
        store.progress(
            "queued",
            JobProgress {
                stage: JobStage::Downloading,
                resource_id: None,
                completed_bytes: 101,
                total_bytes: Some(100),
            }
        ),
        Err(Error::Invalid(_))
    ));
    quiet(&changes, 1);
    let persisted = inner.get("queued").unwrap();
    assert_eq!(persisted.status, JobStatus::Queued);
    assert!(persisted.result.is_none());
    assert_eq!(inner.events("queued", 0).unwrap().len(), 1);
}

#[test]
fn reads_and_read_errors_do_not_publish_changes() {
    let (_, store, mut changes) = fixture();
    store.create(&job("read-only")).unwrap();
    committed(&mut changes, 1);

    assert_eq!(store.get("read-only").unwrap().status, JobStatus::Queued);
    quiet(&changes, 1);
    assert_eq!(store.list(10).unwrap().len(), 1);
    quiet(&changes, 1);
    let events = store.events("read-only", 0).unwrap();
    assert_eq!(events.len(), 1);
    assert!(
        store
            .events("read-only", events[0].sequence)
            .unwrap()
            .is_empty()
    );
    quiet(&changes, 1);
    assert!(matches!(store.get("missing"), Err(Error::NotFound(_))));
    assert!(matches!(
        store.events("missing", 0),
        Err(Error::NotFound(_))
    ));
    assert!(store.list(0).unwrap().is_empty());
    quiet(&changes, 1);
    quiet(&store.subscribe(), 1);
}

#[test]
fn revisions_survive_no_subscribers_and_coalesce_without_losing_latest_state() {
    let inner = Arc::new(SqliteStore::open(":memory:").unwrap());
    let store = NotifyingJobStore::new(inner.clone());
    store.create(&job("before-subscription")).unwrap();
    let mut changes = store.subscribe();
    quiet(&changes, 1);

    store
        .transition("before-subscription", JobStatus::Running, None, None)
        .unwrap();
    store
        .progress(
            "before-subscription",
            JobProgress::stage(JobStage::Preparing),
        )
        .unwrap();
    assert_eq!(inner.events("before-subscription", 0).unwrap().len(), 3);
    committed(&mut changes, 3);
    quiet(&store.subscribe(), 3);
}

/// 仅恢复入口注入提交前故障，其余路径复用真实 SQLite 行为。
struct FailingRecoveryStore {
    inner: SqliteStore,
    fail_recovery: AtomicBool,
}

impl JobStore for FailingRecoveryStore {
    fn create(&self, job: &Job) -> Result<()> {
        self.inner.create(job)
    }

    fn get(&self, id: &str) -> Result<Job> {
        self.inner.get(id)
    }

    fn list(&self, limit: usize) -> Result<Vec<Job>> {
        self.inner.list(limit)
    }

    fn transition(
        &self,
        id: &str,
        status: JobStatus,
        result: Option<Value>,
        error: Option<String>,
    ) -> Result<Job> {
        self.inner.transition(id, status, result, error)
    }

    fn events(&self, id: &str, after: u64) -> Result<Vec<JobEvent>> {
        self.inner.events(id, after)
    }

    fn recover(&self) -> Result<()> {
        if self.fail_recovery.load(Ordering::Relaxed) {
            return Err(Error::Storage("测试注入恢复提交前失败".into()));
        }
        self.inner.recover()
    }

    fn progress(&self, id: &str, progress: JobProgress) -> Result<()> {
        self.inner.progress(id, progress)
    }
}

#[test]
fn failed_recovery_does_not_publish_and_retry_recovers_all_jobs_with_one_revision() {
    let inner = Arc::new(FailingRecoveryStore {
        inner: SqliteStore::open(":memory:").unwrap(),
        fail_recovery: AtomicBool::new(true),
    });
    inner.create(&job("recover-queued")).unwrap();
    inner.create(&job("recover-running")).unwrap();
    inner
        .transition("recover-running", JobStatus::Running, None, None)
        .unwrap();
    let store = NotifyingJobStore::new(inner.clone());
    let mut changes = store.subscribe();

    assert!(matches!(store.recover(), Err(Error::Storage(_))));
    quiet(&changes, 0);
    assert_eq!(
        inner.get("recover-queued").unwrap().status,
        JobStatus::Queued
    );
    assert_eq!(
        inner.get("recover-running").unwrap().status,
        JobStatus::Running
    );
    assert_eq!(inner.events("recover-queued", 0).unwrap().len(), 1);
    assert_eq!(inner.events("recover-running", 0).unwrap().len(), 2);

    inner.fail_recovery.store(false, Ordering::Relaxed);
    store.recover().unwrap();
    assert_eq!(
        inner.get("recover-queued").unwrap().status,
        JobStatus::Failed
    );
    assert_eq!(
        inner.get("recover-running").unwrap().status,
        JobStatus::Failed
    );
    assert_eq!(inner.events("recover-queued", 0).unwrap().len(), 2);
    assert_eq!(inner.events("recover-running", 0).unwrap().len(), 3);
    committed(&mut changes, 1);
}
