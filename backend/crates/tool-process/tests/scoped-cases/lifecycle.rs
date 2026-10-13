use super::{
    lease::Lease,
    support::{self, Case},
};
use deviceforge_tool_process::{
    Error, ScopeCompletion, ScopePolicy, spawn_scoped_stream, spawn_scoped_stream_with_lease,
};
use tokio::time::{Duration, sleep, timeout};
use tokio_util::sync::CancellationToken;

async fn release_tree(case: &Case) {
    case.release("root");
    case.release("child");
    case.release("grandchild");
}

#[tokio::test]
async fn scoped_success_keeps_scope_separate_from_direct_exit() {
    let mut case = Case::new("api-success", "closed", "tree", 0, 0);
    let cancel = CancellationToken::new();
    let mut process = spawn_scoped_stream(
        case.command(),
        support::options(),
        cancel,
        ScopePolicy::OwnedTree,
    )
    .await
    .expect("公开OwnedTree启动");
    case.api_ready().await;
    release_tree(&case).await;
    let exit = process.wait().await.expect("完整范围等待");
    assert_eq!(exit.scope, ScopeCompletion::Complete);
    let direct = exit.direct.expect("直接进程退出");
    assert_eq!(direct.status.code(), Some(0));
    case.finish().await;
}

#[tokio::test]
async fn scoped_nonzero_preserves_direct_status_and_complete_scope() {
    let mut case = Case::new("api-nonzero", "closed", "tree", 7, 0);
    let mut process = spawn_scoped_stream(
        case.command(),
        support::options(),
        CancellationToken::new(),
        ScopePolicy::OwnedTree,
    )
    .await
    .expect("公开OwnedTree启动");
    case.api_ready().await;
    release_tree(&case).await;
    let exit = process.wait().await.expect("范围仍须收口");
    assert_eq!(exit.scope, ScopeCompletion::Complete);
    assert_eq!(exit.direct.expect("保留直接退出").status.code(), Some(7));
    case.finish().await;
}

#[tokio::test]
async fn scoped_parent_exit_keeps_two_generations_owned_until_their_exit() {
    let mut case = Case::new("api-parent-first", "closed", "tree", 0, 0);
    let mut process = spawn_scoped_stream(
        case.command(),
        support::options(),
        CancellationToken::new(),
        ScopePolicy::OwnedTree,
    )
    .await
    .expect("公开OwnedTree启动");
    case.api_ready().await;
    case.release("root");
    sleep(Duration::from_millis(100)).await;
    {
        let observations = case.observations.lock().expect("稳定句柄锁");
        assert!(
            observations
                .iter()
                .find(|value| value.role == "root")
                .expect("根句柄")
                .exited()
        );
        assert!(
            observations
                .iter()
                .filter(|value| value.role != "root")
                .all(|value| !value.exited())
        );
    }
    case.release("child");
    case.release("grandchild");
    let exit = process.wait().await.expect("两代后代完整收口");
    assert_eq!(exit.scope, ScopeCompletion::Complete);
    case.finish().await;
}

#[tokio::test]
async fn scoped_cancel_waits_for_actual_scope_before_returning() {
    let mut case = Case::new("api-cancel", "closed", "tree", 0, 300);
    let cancel = CancellationToken::new();
    let mut process = spawn_scoped_stream(
        case.command(),
        support::options(),
        cancel.clone(),
        ScopePolicy::OwnedTree,
    )
    .await
    .expect("公开OwnedTree启动");
    case.api_ready().await;
    cancel.cancel();
    let exit = process.wait().await.expect("取消必须取得收口结果");
    assert_eq!(exit.scope, ScopeCompletion::Complete);
    assert!(
        matches!(exit.direct, Err(Error::Cancelled)),
        "业务取消与直接退出分离"
    );
    case.finish().await;
}

#[tokio::test]
async fn scoped_deadline_reports_scope_failure_when_cleanup_cannot_finish() {
    let mut case = Case::new("api-deadline", "closed", "tree", 0, 2000);
    let (lease, mut dropped) = Lease::new(case.observations.clone());
    let _ = support::fixture();
    let mut options = support::options();
    options.execution.deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    options.execution.cleanup_timeout = Duration::from_millis(1);
    let mut process = spawn_scoped_stream_with_lease(
        case.command(),
        options,
        CancellationToken::new(),
        ScopePolicy::OwnedTree,
        lease,
    )
    .await
    .expect("公开OwnedTree启动");
    case.api_ready().await;
    let exit = process.wait().await.expect("期限仍须返回范围结果");
    assert!(matches!(exit.direct, Err(Error::Timeout)));
    case.report["returned_scope"] = serde_json::json!(format!("{:?}", exit.scope));
    case.report["cleanup_timeout_ms"] = serde_json::json!(1);
    case.report["all_exited_at_scope_return"] = serde_json::json!(
        case.observations
            .lock()
            .expect("失败返回时的实际句柄")
            .iter()
            .all(super::os::ProcessObservation::exited)
    );
    let value = timeout(Duration::from_secs(5), &mut dropped)
        .await
        .expect("后台范围结束后租约实际释放")
        .expect("租约释放通知");
    assert_eq!(value["all_exited_at_actual_drop"], true);
    assert_eq!(value["observed_count"], 3);
    case.report["lease_release"] = value;
    match exit.scope {
        ScopeCompletion::Complete => case.finish().await,
        ScopeCompletion::Failed => assert!(
            !case.completed,
            "范围失败不得伪装为Complete，外围回收留给用例Drop"
        ),
    }
}

#[tokio::test]
async fn scoped_drop_does_not_release_lease_before_actual_scope() {
    let mut case = Case::new("api-drop-lease", "closed", "tree", 0, 500);
    let (lease, mut dropped) = Lease::new(case.observations.clone());
    let process = spawn_scoped_stream_with_lease(
        case.command(),
        support::options(),
        CancellationToken::new(),
        ScopePolicy::OwnedTree,
        lease,
    )
    .await
    .expect("公开租约启动");
    case.api_ready().await;
    drop(process);
    let value = timeout(Duration::from_secs(5), &mut dropped)
        .await
        .expect("范围结束后租约实际释放")
        .expect("租约释放通知");
    assert_eq!(value["all_exited_at_actual_drop"], true);
    assert_eq!(value["observed_count"], 3);
    case.report["lease_release"] = value;
    case.finish().await;
}

#[tokio::test]
async fn scoped_inherited_pipes_require_eof_after_all_scope_members_exit() {
    let mut case = Case::new("api-pipes", "inherit", "tree", 0, 250);
    let mut process = spawn_scoped_stream(
        case.command(),
        support::options(),
        CancellationToken::new(),
        ScopePolicy::OwnedTree,
    )
    .await
    .expect("公开管道范围启动");
    case.api_ready().await;
    let nonce = case.report["nonce"].as_str().expect("本轮身份").to_owned();
    let markers = ["root", "child", "grandchild"].map(|role| format!("DF_SCOPED:{role}:{nonce}"));
    let mut bytes = Vec::new();
    timeout(support::READY_BUDGET, async {
        while markers
            .iter()
            .any(|marker| !String::from_utf8_lossy(&bytes).contains(marker))
        {
            let chunk = process.recv().await.expect("三角色实际管道标记未齐");
            bytes.extend_from_slice(&chunk.bytes);
            assert!(bytes.len() <= 4096, "夹具管道输出必须有界");
        }
    })
    .await
    .expect("三角色实际管道标记必须在原ready预算内齐全");
    case.release("root");
    timeout(support::EXIT_BUDGET, async {
        loop {
            let root_exited = case
                .observations
                .lock()
                .expect("稳定句柄锁")
                .iter()
                .find(|value| value.role == "root")
                .expect("根句柄")
                .exited();
            if root_exited {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("根实际句柄必须退出");
    assert!(
        case.observations
            .lock()
            .expect("稳定后代句柄锁")
            .iter()
            .filter(|value| value.role != "root")
            .all(|value| value.running())
    );
    assert!(
        timeout(Duration::from_millis(200), async {
            while process.recv().await.is_some() {}
        })
        .await
        .is_err(),
        "已退出根的后代仍持有管道时不得提前EOF"
    );
    case.report["pipe_markers"] = serde_json::json!(markers);
    case.report["eof_pending_after_root_exit"] = serde_json::json!(true);
    case.report["descendants_running_after_root_exit"] = serde_json::json!(true);
    case.release("child");
    case.release("grandchild");
    let exit = process.wait().await.expect("管道完全收口");
    assert_eq!(exit.scope, ScopeCompletion::Complete);
    case.finish().await;
}

#[tokio::test]
async fn scoped_breakaway_attempt_is_observed_under_public_job() {
    let mut case = Case::new("api-breakaway", "closed", "breakaway-external", 0, 0);
    let mut process = spawn_scoped_stream(
        case.command(),
        support::options(),
        CancellationToken::new(),
        ScopePolicy::OwnedTree,
    )
    .await
    .expect("公开OwnedTree启动");
    let ready = case.api_ready_root().await;
    assert_eq!(ready["role"], "root");
    let breakaway = case.read_json("breakaway.json").await;
    assert_eq!(breakaway["private_job_added"], false);
    assert_eq!(breakaway["ambient_job_member"], true);
    assert_eq!(breakaway["create_process_succeeded"], false);
    assert_eq!(breakaway["raw_os_error"], 5);
    case.report["breakaway"] = breakaway;
    case.release("root");
    let exit = process.wait().await.expect("breakaway拒绝后完整收口");
    assert_eq!(exit.scope, ScopeCompletion::Complete);
    assert_eq!(exit.direct.expect("直接根退出").status.code(), Some(0));
    case.finish().await;
}
