//! 恢复只认真实退出凭据，且严格限制在同一 owner 身份。
use super::*;
use std::sync::atomic::Ordering;

fn assert_busy(repository: &Repository) {
    assert!(matches!(
        repository.write(),
        Err(deviceforge_tool_repository::Error::Busy)
    ));
}

#[test]
fn unknown_exit_keeps_inactive_debt_blocked_until_real_evidence_arrives() {
    let owner = Arc::new(AtomicBool::new(true));
    let call = crate::plugin_resources::recovery::Call::register(&owner).unwrap();
    call.retain();
    call.release(None);
    assert!(!recovery_ready(&owner), "业务已排空不能推断直接进程已退出");
    assert!(matches!(confirm_recovery(&owner), Err(Error::Conflict(_))));
    // 模拟同一调用的后台系统 wait 成功；未到此证据前始终失败关闭。
    call.process_exited();
    assert!(recovery_ready(&owner));
    confirm_recovery(&owner).unwrap();
}

#[test]
fn registry_is_bounded_without_strongly_owning_plugin_identity() {
    let owner = Arc::new(AtomicBool::new(true));
    let mut calls = Vec::new();
    for _ in 0..64 {
        calls.push(ToolLease::new(None, &owner).unwrap());
    }
    assert_eq!(
        Arc::strong_count(&owner),
        1,
        "台账与租约不能强持有插件 owner"
    );
    assert!(matches!(
        ToolLease::new(None, &owner),
        Err(Error::Conflict(_))
    ));
    drop(calls.pop());
    calls.push(ToolLease::new(None, &owner).unwrap());
    drop(calls);
    assert!(recovery_ready(&owner));
    confirm_recovery(&owner).unwrap();
    let observer = Arc::downgrade(&owner);
    let active = ToolLease::new(None, &owner).unwrap();
    drop(owner);
    assert!(observer.upgrade().is_none());
    drop(active);
}

#[tokio::test]
async fn process_still_owned_blocks_recovery_even_after_business_owner_drops() {
    let _serial = SERIAL.lock().await;
    let fixture = Fixture::new();
    let unresolved = Arc::new(AtomicBool::new(true));
    let lease = fixture.acquire_for(&unresolved).await.unwrap();
    let process = lease.clone();
    lease.retain();
    drop(lease);
    assert!(!recovery_ready(&unresolved));
    assert!(matches!(
        confirm_recovery(&unresolved),
        Err(Error::Conflict(_))
    ));
    assert_busy(&fixture.repository);
    process.process_exited();
    assert!(!recovery_ready(&unresolved), "仍持有调用租约时不能释放");
    drop(process);
    assert!(recovery_ready(&unresolved));
    assert_busy(&fixture.repository);
    confirm_recovery(&unresolved).unwrap();
    fixture.repository.write().unwrap();
    assert!(
        unresolved.load(Ordering::Acquire),
        "工具租约层不清除外部资源风险"
    );
}

#[tokio::test]
async fn confirmation_releases_only_matching_group_and_preserves_other_active_lease() {
    let _serial = SERIAL.lock().await;
    let first = Fixture::new();
    let second = Fixture::new();
    let owner = Arc::new(AtomicBool::new(true));
    let other = Arc::new(AtomicBool::new(true));
    let lease = first.acquire_for(&owner).await.unwrap();
    lease.retain();
    lease.process_exited();
    drop(lease);
    let debt = second.acquire_for(&other).await.unwrap();
    debt.retain();
    debt.process_exited();
    drop(debt);
    let active = first.acquire_for(&other).await.unwrap();
    assert!(recovery_ready(&owner));
    assert!(!recovery_ready(&other));
    confirm_recovery(&owner).unwrap();
    assert_busy(&first.repository);
    assert_busy(&second.repository);
    drop(active);
    first.repository.write().unwrap();
    assert_busy(&second.repository);
    confirm_recovery(&other).unwrap();
    second.repository.write().unwrap();
}

#[tokio::test]
async fn clearing_flag_alone_cannot_release_debt_or_replace_owner_identity() {
    let _serial = SERIAL.lock().await;
    let fixture = Fixture::new();
    let owner = Arc::new(AtomicBool::new(true));
    let lease = fixture.acquire_for(&owner).await.unwrap();
    lease.retain();
    lease.process_exited();
    drop(lease);
    owner.store(false, Ordering::Release);
    let replacement = Arc::new(AtomicBool::new(false));
    confirm_recovery(&replacement).unwrap();
    assert_busy(&fixture.repository);
    assert!(recovery_ready(&owner));
    confirm_recovery(&owner).unwrap();
    fixture.repository.write().unwrap();
}

#[tokio::test]
async fn public_process_lease_drop_records_exit_but_never_external_cleanup() {
    let _serial = SERIAL.lock().await;
    let fixture = Fixture::new();
    let unresolved = Arc::new(AtomicBool::new(true));
    let lease = fixture.acquire_for(&unresolved).await.unwrap();
    let process = lease.process_lease();
    lease.retain();
    drop(lease);
    assert!(!recovery_ready(&unresolved));
    drop(process);
    assert!(recovery_ready(&unresolved));
    assert_busy(&fixture.repository);
    confirm_recovery(&unresolved).unwrap();
    fixture.repository.write().unwrap();
}

#[tokio::test]
async fn cooperative_recovery_returns_with_its_own_process_lease_synchronously_removed() {
    let _serial = SERIAL.lock().await;
    let fixture = Fixture::new();
    let unresolved = Arc::new(AtomicBool::new(true));
    let old = fixture.acquire_for(&unresolved).await.unwrap();
    old.retain();
    old.process_exited();
    drop(old);
    let script = r#"
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
let request;
lines.on('line', line => {
    const frame = JSON.parse(line);
    if (!request) {
        request = frame;
        process.stdout.write(JSON.stringify({ protocol_version:4,
            request_id:request.request_id, command:'ready' }) + '\n');
        return;
    }
    process.stdout.write(JSON.stringify({ response:{ protocol_version:4,
        request_id:request.request_id, result:{ recovered:true } }, cleanup:'complete' }) + '\n');
    lines.on('close', () => process.exit(0));
});
"#;
    let args = vec!["-e".into(), script.into()];
    let input = serde_json::to_vec(&json!({"protocol_version":4,"request_id":"debt-recovery",
        "operation":"runtime.recover","input":{}}))
    .unwrap();
    let mut input = input;
    input.push(b'\n');
    let response = crate::process::cooperative::run_with_context(
        crate::process::cooperative::Invocation {
            executable: "node",
            args: &args,
            input,
            request_id: "debt-recovery",
            cancel: CancellationToken::new(),
            directory: None,
            configuration: None,
            resources: Some(&fixture.resources),
            timeout: Duration::from_secs(5),
            deadline: None,
        },
        unresolved.clone(),
    )
    .await
    .unwrap();
    assert_eq!(response.result, Some(json!({"recovered":true})));
    // 不让出调度权；若 Owner 只是异步 reap，此处会把恢复自身认作活动调用。
    assert!(recovery_ready(&unresolved));
    assert_busy(&fixture.repository);
    confirm_recovery(&unresolved).unwrap();
    fixture.repository.write().unwrap();
}
