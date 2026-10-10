use crate::fixture::{
    Fixture, Flow, context, entered, expire, join_live, join_paused,
    store::{Delays, Gate},
};
use apk_domain::{Error, ExecutionContext};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

async fn preflight(flow: Flow, expired: bool) {
    let fixture = Fixture::new("response", Delays::default()).await;
    let source = fixture.source(flow).await;
    let token = CancellationToken::new();
    let point = if expired {
        Instant::now() - Duration::from_secs(1)
    } else {
        token.cancel();
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
            "预过期精确 Timeout：{result:?}"
        );
    } else {
        assert!(
            matches!(result, Err(Error::Cancelled)),
            "预取消精确 Cancelled：{result:?}"
        );
    }
    assert_eq!(fixture.store.counts(), (0, 0, 0));
    fixture.assert_no_tool();
}

#[tokio::test]
async fn expired_build_has_zero_download_put_and_tool() {
    preflight(Flow::Build, true).await;
}
#[tokio::test]
async fn expired_decode_has_zero_download_put_and_tool() {
    preflight(Flow::Decode, true).await;
}
#[tokio::test]
async fn expired_scan_has_zero_download_put_and_tool() {
    preflight(Flow::Scan, true).await;
}
#[tokio::test]
async fn expired_extract_has_zero_download_put_and_tool() {
    preflight(Flow::Extract, true).await;
}
#[tokio::test]
async fn cancelled_build_has_zero_download_put_and_tool() {
    preflight(Flow::Build, false).await;
}
#[tokio::test]
async fn cancelled_decode_has_zero_download_put_and_tool() {
    preflight(Flow::Decode, false).await;
}
#[tokio::test]
async fn cancelled_scan_has_zero_download_put_and_tool() {
    preflight(Flow::Scan, false).await;
}
#[tokio::test]
async fn cancelled_extract_has_zero_download_put_and_tool() {
    preflight(Flow::Extract, false).await;
}

async fn slow_prepare(flow: Flow) {
    let gate = Gate::new();
    let fixture = Fixture::new(
        "response",
        Delays {
            download: Some(gate.clone()),
            ..Delays::default()
        },
    )
    .await;
    let source = fixture.source(flow).await;
    // 真实编译、仓库和种子 I/O 全部完成后，才冻结宿主时间。
    tokio::time::pause();
    let point = tokio::time::Instant::now() + Duration::from_secs(60);
    let execution = context(point);
    let task = fixture.start(flow, &source.id, CancellationToken::new(), execution);
    entered(&gate).await;
    assert_eq!(fixture.store.counts(), (1, 0, 0));
    assert_eq!(execution.deadline, Some(point.into_std()));
    assert!(!task.is_finished(), "真实准备门闩内不能先完成");
    expire(point).await;
    let result = join_paused(task).await;
    tokio::time::resume();
    assert!(
        matches!(result, Err(Error::Timeout)),
        "慢准备必须耗尽原 D：{result:?}"
    );
    gate.open();
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
    assert_eq!(fixture.store.counts(), (1, 0, 0));
    fixture.assert_no_tool();
}

#[tokio::test]
async fn slow_build_download_uses_original_point_without_tool() {
    slow_prepare(Flow::Build).await;
}
#[tokio::test]
async fn slow_decode_download_uses_original_point_without_tool() {
    slow_prepare(Flow::Decode).await;
}
#[tokio::test]
async fn slow_scan_download_uses_original_point_without_publication() {
    slow_prepare(Flow::Scan).await;
}
#[tokio::test]
async fn slow_extract_download_uses_original_point_without_tool() {
    slow_prepare(Flow::Extract).await;
}

async fn real_tool_deadline(flow: Flow) {
    let gate = Gate::new();
    let fixture = Fixture::new(
        "hold",
        Delays {
            download: Some(gate.clone()),
            ..Delays::default()
        },
    )
    .await;
    let source = fixture.source(flow).await;
    tokio::time::pause();
    let point = tokio::time::Instant::now() + Duration::from_secs(60);
    let execution = context(point);
    let task = fixture.start(flow, &source.id, CancellationToken::new(), execution);
    entered(&gate).await;
    tokio::time::advance(Duration::from_secs(45)).await;
    gate.open();
    let pid = fixture.ready().await;
    assert_eq!(point - tokio::time::Instant::now(), Duration::from_secs(15));
    assert_eq!(execution.deadline, Some(point.into_std()));
    assert!(!task.is_finished(), "工具 ready 后仍等待本次 release");
    expire(point).await;
    // OS 清理使用正常计时，不能让观测循环阻塞清理定时器。
    tokio::time::resume();
    let result = join_live(task).await;
    assert!(
        matches!(result, Err(Error::Timeout)),
        "工具不得重获阶段预算：{result:?}"
    );
    assert_eq!(fixture.pid(), pid);
    fixture.assert_tool_exited().await;
    assert_eq!(fixture.store.counts(), (1, 0, 0));
    assert!(!fixture.control.join("response_written").exists());
}

#[tokio::test]
async fn real_build_tool_exits_at_point_after_prepare_consumed_budget() {
    real_tool_deadline(Flow::Build).await;
}
#[tokio::test]
async fn real_decode_tool_exits_at_point_after_prepare_consumed_budget() {
    real_tool_deadline(Flow::Decode).await;
}
#[tokio::test]
async fn real_extract_tool_exits_at_point_after_prepare_consumed_budget() {
    real_tool_deadline(Flow::Extract).await;
}

async fn real_tool_cancel(flow: Flow) {
    let fixture = Fixture::new("hold", Delays::default()).await;
    let source = fixture.source(flow).await;
    tokio::time::pause();
    let point = tokio::time::Instant::now() + Duration::from_secs(60);
    let execution = context(point);
    let token = CancellationToken::new();
    let task = fixture.start(flow, &source.id, token.clone(), execution);
    let pid = fixture.ready().await;
    tokio::time::advance(Duration::from_secs(50)).await;
    assert_eq!(point - tokio::time::Instant::now(), Duration::from_secs(10));
    assert_eq!(execution.deadline, Some(point.into_std()));
    assert!(!task.is_finished());
    token.cancel();
    tokio::time::resume();
    let result = join_live(task).await;
    assert!(
        matches!(result, Err(Error::Cancelled)),
        "原 D 前显式取消精确 Cancelled：{result:?}"
    );
    assert_eq!(fixture.pid(), pid);
    fixture.assert_tool_exited().await;
    assert_eq!(fixture.store.counts(), (1, 0, 0));
    assert!(!fixture.control.join("response_written").exists());
}

#[tokio::test]
async fn running_build_cancel_exits_same_pid_without_publication() {
    real_tool_cancel(Flow::Build).await;
}
#[tokio::test]
async fn running_decode_cancel_exits_same_pid_without_publication() {
    real_tool_cancel(Flow::Decode).await;
}
#[tokio::test]
async fn running_extract_cancel_exits_same_pid_without_publication() {
    real_tool_cancel(Flow::Extract).await;
}
