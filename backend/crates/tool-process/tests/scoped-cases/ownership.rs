use super::support::{self, Case};
use deviceforge_tool_process::{ScopeCompletion, ScopePolicy, spawn_scoped_stream};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn scoped_pre_cancel_never_starts_tree() {
    let case = Case::new("api-pre-cancel", "closed", "tree", 0, 0);
    let cancel = CancellationToken::new();
    cancel.cancel();
    let result = spawn_scoped_stream(
        case.command(),
        support::options(),
        cancel,
        ScopePolicy::OwnedTree,
    )
    .await;
    assert!(result.is_err());
    assert!(!case.directory.join("ready-root.json").exists());
}

#[tokio::test]
async fn scoped_rejects_input_bytes_before_start() {
    let case = Case::new("api-input-reject", "closed", "tree", 0, 0);
    let mut command = case.command();
    command.input = Some(b"unexpected");
    let result = spawn_scoped_stream(
        command,
        support::options(),
        CancellationToken::new(),
        ScopePolicy::OwnedTree,
    )
    .await;
    assert!(result.is_err());
    assert!(!case.directory.join("ready-root.json").exists());
}

#[tokio::test]
async fn scoped_public_policy_has_no_implicit_fallback() {
    let mut case = Case::new("api-policy", "closed", "tree", 0, 0);
    let mut process = spawn_scoped_stream(
        case.command(),
        support::options(),
        CancellationToken::new(),
        ScopePolicy::OwnedTree,
    )
    .await
    .expect("OwnedTree公开策略必须启动，不得静默回退");
    case.api_ready().await;
    case.release("root");
    case.release("child");
    case.release("grandchild");
    let exit = process.wait().await.expect("范围收口");
    assert_eq!(exit.scope, ScopeCompletion::Complete);
    case.finish().await;
}
