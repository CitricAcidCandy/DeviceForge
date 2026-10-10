use crate::fixture::{
    FLOWS, Fixture, Flow, TOOL_BUDGET, context, expire, join_live, join_paused,
    store::{Delays, Gate},
};
use apk_domain::{Error, ExecutionContext};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

async fn preflight(flow: Flow, expired: bool, cancelled: bool) {
    let fixture = Fixture::new(Delays::default()).await;
    let source = fixture.source(flow).await;
    let token = CancellationToken::new();
    if cancelled {
        token.cancel();
    }
    let point = if expired {
        Instant::now() - Duration::from_secs(1)
    } else {
        Instant::now() + Duration::from_secs(30)
    };
    let result = join_live(fixture.start(
        flow,
        &source.id,
        token,
        ExecutionContext {
            deadline: Some(point),
        },
    ))
    .await;
    if expired {
        assert!(
            matches!(result, Err(Error::Timeout)),
            "过期优先且只接受 Timeout：{result:?}"
        );
    } else {
        assert!(
            matches!(result, Err(Error::Cancelled)),
            "预取消只接受 Cancelled：{result:?}"
        );
    }
    assert_eq!(fixture.store.counts(), (0, 0, 0));
    fixture.assert_no_tool();
}

#[tokio::test]
async fn expired_manifest_has_zero_download_put_and_tool() {
    preflight(Flow::Manifest, true, false).await;
}

#[tokio::test]
async fn expired_signature_has_zero_download_put_and_tool() {
    preflight(Flow::Signature, true, false).await;
}

#[tokio::test]
async fn expired_extract_has_zero_download_put_and_tool() {
    preflight(Flow::Extract, true, false).await;
}

#[tokio::test]
async fn cancelled_manifest_has_zero_download_put_and_tool() {
    preflight(Flow::Manifest, false, true).await;
}

#[tokio::test]
async fn cancelled_signature_has_zero_download_put_and_tool() {
    preflight(Flow::Signature, false, true).await;
}

#[tokio::test]
async fn cancelled_extract_has_zero_download_put_and_tool() {
    preflight(Flow::Extract, false, true).await;
}

#[tokio::test]
async fn expired_point_wins_over_pre_cancelled_token_in_all_three_flows() {
    for flow in FLOWS {
        preflight(flow, true, true).await;
    }
}

async fn entered(gate: &Arc<Gate>) {
    let gate = gate.clone();
    join_paused(tokio::spawn(async move { gate.wait_entered().await })).await;
}

async fn slow_download(flow: Flow, streamed: bool) {
    let gate = Gate::new();
    let delays = if streamed {
        Delays {
            stream: Some(gate.clone()),
            ..Delays::default()
        }
    } else {
        Delays {
            download: Some(gate.clone()),
            ..Delays::default()
        }
    };
    let fixture = Fixture::new(delays).await;
    let source = fixture.source(flow).await;
    // 构建工具和种子真实 I/O 已完成；仅冻结宿主调度时钟。
    tokio::time::pause();
    let point = tokio::time::Instant::now() + Duration::from_secs(30);
    let execution = context(point);
    let task = fixture.start(flow, &source.id, CancellationToken::new(), execution);
    entered(&gate).await;
    assert_eq!(execution.deadline, Some(point.into_std()));
    assert_eq!(fixture.store.counts(), (1, 0, 0));
    assert!(!task.is_finished(), "原预算内必须仍在真实准备门闩");
    expire(point).await;
    let result = join_paused(task).await;
    tokio::time::resume();
    assert!(
        matches!(result, Err(Error::Timeout)),
        "准备耗尽原 D 只接受 Timeout：{result:?}"
    );
    gate.open();
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
    assert_eq!(fixture.store.counts(), (1, 0, 0));
    fixture.assert_no_tool();
}

#[tokio::test]
async fn slow_manifest_download_expires_before_tool_start() {
    slow_download(Flow::Manifest, false).await;
}

#[tokio::test]
async fn slow_signature_download_expires_before_tool_start() {
    slow_download(Flow::Signature, false).await;
}

#[tokio::test]
async fn slow_extract_download_expires_without_publication() {
    slow_download(Flow::Extract, false).await;
}

#[tokio::test]
async fn pending_download_body_uses_original_point_in_all_three_flows() {
    for flow in FLOWS {
        slow_download(flow, true).await;
    }
}

async fn real_timeout(flow: Flow) {
    let mut fixture = Fixture::new(Delays::default()).await;
    fixture.set_tool_mode("hold");
    let source = fixture.source(flow).await;
    let point = Instant::now() + TOOL_BUDGET;
    let task = fixture.start(
        flow,
        &source.id,
        CancellationToken::new(),
        ExecutionContext {
            deadline: Some(point),
        },
    );
    let pid = fixture.ready().await;
    assert!(!task.is_finished(), "真实工具应仍 hold，不能用终态当 ready");
    let result = join_live(task).await;
    assert!(
        matches!(result, Err(Error::Timeout)),
        "运行到原 D 只接受 Timeout：{result:?}"
    );
    assert_eq!(fixture.pid(), pid);
    fixture.assert_tool_exited().await;
    assert_eq!(fixture.store.counts(), (1, 0, 0));
    assert!(!fixture.control.join("response_written").exists());
}

#[tokio::test]
async fn real_manifest_tool_exits_at_original_deadline_without_publication() {
    real_timeout(Flow::Manifest).await;
}

#[tokio::test]
async fn real_signature_tool_exits_at_original_deadline_without_publication() {
    real_timeout(Flow::Signature).await;
}

#[tokio::test]
async fn prepare_time_is_deducted_from_real_tool_remaining_budget() {
    let gate = Gate::new();
    let mut fixture = Fixture::new(Delays {
        download: Some(gate.clone()),
        ..Delays::default()
    })
    .await;
    fixture.set_tool_mode("hold");
    let source = fixture.source(Flow::Manifest).await;
    tokio::time::pause();
    let point = tokio::time::Instant::now() + Duration::from_secs(60);
    let execution = context(point);
    let task = fixture.start(
        Flow::Manifest,
        &source.id,
        CancellationToken::new(),
        execution,
    );
    entered(&gate).await;
    tokio::time::advance(Duration::from_secs(45)).await;
    gate.open();
    fixture.ready().await;
    assert_eq!(execution.deadline, Some(point.into_std()));
    assert_eq!(point - tokio::time::Instant::now(), Duration::from_secs(15));
    assert!(!task.is_finished());
    expire(point).await;
    // 清理用真实时钟等待 OS 退出，不让暂停观测器卡住清理计时器。
    tokio::time::resume();
    let result = join_live(task).await;
    assert!(
        matches!(result, Err(Error::Timeout)),
        "工具不得重获阶段预算：{result:?}"
    );
    fixture.assert_tool_exited().await;
    assert_eq!(fixture.store.counts(), (1, 0, 0));
}

#[tokio::test]
async fn near_deadline_explicit_cancel_of_real_tool_never_publishes() {
    let mut fixture = Fixture::new(Delays::default()).await;
    fixture.set_tool_mode("hold");
    let source = fixture.source(Flow::Signature).await;
    tokio::time::pause();
    let point = tokio::time::Instant::now() + Duration::from_secs(60);
    let execution = context(point);
    let token = CancellationToken::new();
    let task = fixture.start(Flow::Signature, &source.id, token.clone(), execution);
    fixture.ready().await;
    tokio::time::advance(Duration::from_millis(59_000)).await;
    assert_eq!(point - tokio::time::Instant::now(), Duration::from_secs(1));
    assert_eq!(execution.deadline, Some(point.into_std()));
    token.cancel();
    // 取消已在 D 前线性排序；恢复时钟让真实 OS 清理等待正常计时。
    tokio::time::resume();
    let result = join_live(task).await;
    assert!(
        matches!(result, Err(Error::Cancelled)),
        "D 前显式取消必须保持 Cancelled：{result:?}"
    );
    fixture.assert_tool_exited().await;
    assert_eq!(fixture.store.counts(), (1, 0, 0));
    assert!(!fixture.control.join("response_written").exists());
}

#[tokio::test]
async fn extract_publication_wait_uses_original_point_and_cannot_resume_late() {
    let gate = Gate::new();
    let fixture = Fixture::new(Delays {
        put: Some(gate.clone()),
        ..Delays::default()
    })
    .await;
    let source = fixture.source(Flow::Extract).await;
    tokio::time::pause();
    let point = tokio::time::Instant::now() + Duration::from_secs(30);
    let execution = context(point);
    let task = fixture.start(
        Flow::Extract,
        &source.id,
        CancellationToken::new(),
        execution,
    );
    entered(&gate).await;
    assert_eq!(fixture.store.counts(), (1, 1, 0));
    assert_eq!(execution.deadline, Some(point.into_std()));
    expire(point).await;
    let result = join_paused(task).await;
    tokio::time::resume();
    assert!(
        matches!(result, Err(Error::Timeout)),
        "发布仍使用原 D：{result:?}"
    );
    gate.open();
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
    assert_eq!(fixture.store.counts(), (1, 1, 0));
    fixture.assert_no_tool();
}

#[tokio::test]
async fn extract_cancel_while_publication_waits_never_commits() {
    let gate = Gate::new();
    let fixture = Fixture::new(Delays {
        put: Some(gate.clone()),
        ..Delays::default()
    })
    .await;
    let source = fixture.source(Flow::Extract).await;
    tokio::time::pause();
    let point = tokio::time::Instant::now() + Duration::from_secs(30);
    let token = CancellationToken::new();
    let task = fixture.start(Flow::Extract, &source.id, token.clone(), context(point));
    entered(&gate).await;
    token.cancel();
    let result = join_paused(task).await;
    tokio::time::resume();
    assert!(
        matches!(result, Err(Error::Cancelled)),
        "发布等待取消：{result:?}"
    );
    gate.open();
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
    assert_eq!(fixture.store.counts(), (1, 1, 0));
    fixture.assert_no_tool();
}
