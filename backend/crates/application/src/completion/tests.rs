use super::*;
use apk_domain::JobStatus;
use serde_json::json;

fn succeeded() -> Job {
    Job {
        id: "completion-test".into(),
        operation: "ordinary.echo".into(),
        input: json!({}),
        status: JobStatus::Succeeded,
        result: Some(json!({"ok":true})),
        error: None,
        created_at: 0,
    }
}

#[tokio::test(start_paused = true)]
async fn observed_cleanup_failure_before_storage_slot_survives_cancel_and_expiry() {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    let completion = Completion::with_deadline(Some(deadline));
    completion
        .record_failure(&Error::CleanupFailed.into())
        .unwrap();
    assert!(completion.request_cancel().unwrap());
    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    let CancellationClaim::Proceed(_claim, status, error) = completion.claim_cancelled().unwrap()
    else {
        panic!("尚未提交的风险必须取得失败资格");
    };
    assert_eq!(status, JobStatus::Failed);
    assert_eq!(error, Some(Error::CleanupFailed.to_string()));
}

#[tokio::test(start_paused = true)]
async fn cleanup_failure_wins_over_expired_deadline_and_unclaimed_cancellation() {
    for (expire, cancel) in [(true, false), (false, true)] {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
        let completion = Completion::with_deadline(Some(deadline));
        if cancel {
            assert!(completion.request_cancel().unwrap());
        }
        if expire {
            tokio::time::advance(std::time::Duration::from_secs(2)).await;
        }
        let CancellationClaim::Proceed(_claim, status, error) = completion
            .claim_failed(Error::CleanupFailed.into())
            .unwrap()
        else {
            panic!("清理失败必须取得失败资格");
        };
        assert_eq!(status, JobStatus::Failed);
        assert_eq!(error, Some(Error::CleanupFailed.to_string()));
    }
}

#[tokio::test(start_paused = true)]
async fn failed_cleanup_commit_preserves_risk_across_cancel_timeout_and_storage_retry() {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    let completion = Completion::with_deadline(Some(deadline));
    let CancellationClaim::Proceed(claim, _, _) = completion
        .claim_failed(Error::CleanupFailed.into())
        .unwrap()
    else {
        panic!("清理失败必须取得首次资格");
    };
    // 模拟存储事务返回失败：资格释放后不能丢失已记录的清理风险。
    drop(claim);
    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    assert!(completion.request_cancel().unwrap());
    assert!(matches!(
        completion.cancellation_error().unwrap(),
        Error::CleanupFailed
    ));
    let CancellationClaim::Proceed(_claim, status, error) = completion.claim_cancelled().unwrap()
    else {
        panic!("取消重试必须取得失败资格");
    };
    assert_eq!(status, JobStatus::Failed);
    assert_eq!(error, Some(Error::CleanupFailed.to_string()));
}

#[test]
fn cancellation_before_success_qualification_cannot_be_replaced_by_late_success() {
    let completion = Completion::new();
    let cancel = CancellationToken::new();
    assert!(completion.request_cancel().unwrap());
    assert!(matches!(
        completion.claim(None, &cancel),
        Err(Error::Cancelled)
    ));
    assert!(completion.cancel_after_commit().unwrap().is_none());
}

#[test]
fn accepted_success_releases_gate_lock_but_cancel_waits_for_actual_commit() {
    let completion = Completion::new();
    let claim = completion.claim(None, &CancellationToken::new()).unwrap();
    assert!(!completion.request_cancel().unwrap());
    let (started, arrival) = std::sync::mpsc::channel();
    let (completed, result) = std::sync::mpsc::channel();
    let waiting = completion.clone();
    let thread = std::thread::spawn(move || {
        started.send(()).unwrap();
        completed
            .send(waiting.cancel_after_commit().unwrap())
            .unwrap();
    });
    arrival
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    assert!(result.try_recv().is_err());
    claim.committed(succeeded());
    let terminal = result
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap()
        .unwrap();
    assert_eq!(terminal.status, JobStatus::Succeeded);
    thread.join().unwrap();
}

#[test]
fn late_failed_claim_waits_for_earlier_cancelled_transaction() {
    let completion = Completion::new();
    let CancellationClaim::Proceed(claim, status, error) = completion.claim_cancelled().unwrap()
    else {
        panic!("取消必须先取得资格");
    };
    assert_eq!(status, JobStatus::Cancelled);
    assert!(error.is_none());
    let (started, arrival) = std::sync::mpsc::channel();
    let (finished, result) = std::sync::mpsc::channel();
    let waiting = completion.clone();
    let worker = std::thread::spawn(move || {
        started.send(()).unwrap();
        match waiting.claim_failed(Error::Timeout.into()).unwrap() {
            CancellationClaim::Committed(job) => finished.send(job).unwrap(),
            CancellationClaim::Proceed(..) => panic!("晚失败不能越过先取得资格的取消事务"),
        }
    });
    arrival
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    assert!(result.try_recv().is_err());
    let mut cancelled = succeeded();
    cancelled.status = JobStatus::Cancelled;
    cancelled.result = None;
    claim.committed(cancelled);
    let actual = result
        .recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    assert_eq!(actual.status, JobStatus::Cancelled);
    assert!(actual.error.is_none());
    worker.join().unwrap();
}

#[test]
fn failed_storage_claim_releases_cancel_waiter_and_can_be_cancelled() {
    let completion = Completion::new();
    let claim = completion.claim(None, &CancellationToken::new()).unwrap();
    assert!(!completion.request_cancel().unwrap());
    drop(claim);
    assert!(completion.cancel_after_commit().unwrap().is_none());
    assert!(completion.request_cancel().unwrap());
    assert!(matches!(
        completion.claim(None, &CancellationToken::new()),
        Err(Error::Cancelled)
    ));
}

#[tokio::test(start_paused = true)]
async fn deadline_is_rechecked_when_success_qualification_is_claimed() {
    let completion = Completion::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    assert!(matches!(
        completion.claim(Some(deadline), &CancellationToken::new()),
        Err(Error::Timeout)
    ));
    assert!(completion.request_cancel().unwrap());
}

#[tokio::test(start_paused = true)]
async fn cancellation_during_expired_cleanup_keeps_timeout_reason() {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    let completion = Completion::with_deadline(Some(deadline));
    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    assert!(completion.request_cancel().unwrap());
    assert!(matches!(
        completion.cancellation_error().unwrap(),
        Error::Timeout
    ));
    assert!(completion.cancel_after_commit().unwrap().is_none());
    assert!(matches!(
        completion.cancellation_error().unwrap(),
        Error::Timeout
    ));
}

#[tokio::test(start_paused = true)]
async fn success_claim_before_deadline_is_not_replaced_by_expired_cancel() {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    let completion = Completion::with_deadline(Some(deadline));
    let claim = completion
        .claim(Some(deadline), &CancellationToken::new())
        .unwrap();
    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    assert!(!completion.request_cancel().unwrap());
    claim.committed(succeeded());
    assert_eq!(
        completion.cancel_after_commit().unwrap().unwrap().status,
        JobStatus::Succeeded
    );
}

#[tokio::test(start_paused = true)]
async fn failed_rejection_commit_restores_cancelled_reason_for_retry() {
    let completion = Completion::new();
    assert!(completion.request_cancel().unwrap());
    let CancellationClaim::Proceed(claim, status, error) = completion
        .claim_failed(Failure::Other("晚到执行失败".into()))
        .unwrap()
    else {
        panic!("首次失败提交必须取得资格");
    };
    assert_eq!(status, JobStatus::Cancelled);
    assert!(error.is_none());
    drop(claim);
    let CancellationClaim::Proceed(_claim, status, error) = completion
        .claim_failed(Failure::Other("重试执行失败".into()))
        .unwrap()
    else {
        panic!("存储失败后必须允许重试");
    };
    assert_eq!(status, JobStatus::Cancelled);
    assert!(error.is_none());
}

#[tokio::test(start_paused = true)]
async fn failed_rejection_commit_restores_timeout_reason_for_retry() {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    let completion = Completion::with_deadline(Some(deadline));
    tokio::time::advance(std::time::Duration::from_secs(2)).await;
    let CancellationClaim::Proceed(claim, status, error) = completion.claim_cancelled().unwrap()
    else {
        panic!("到期提交必须取得资格");
    };
    assert_eq!(status, JobStatus::Failed);
    assert_eq!(error.as_deref(), Some("执行超时"));
    drop(claim);
    assert!(matches!(
        completion.cancellation_error().unwrap(),
        Error::Timeout
    ));
    let CancellationClaim::Proceed(_claim, status, error) = completion
        .claim_failed(Failure::Other("晚到执行失败".into()))
        .unwrap()
    else {
        panic!("存储失败后必须允许重试");
    };
    assert_eq!(status, JobStatus::Failed);
    assert_eq!(error.as_deref(), Some("执行超时"));
}
