//! 换代后只允许显式重新选择；旧命令不能进入新目标的证据。
use super::*;

#[tokio::test(start_paused = true)]
async fn debugger_reload_inherits_thirty_second_budget_and_queue_does_not_restart_it() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let session = open(&service, &instance);
    let mut reload = request(&session);
    reload.tool = DebugTool::Reload;
    reload.parameters = json!({"confirmed":true});
    let receipt = service.enqueue(reload).unwrap();
    assert_eq!(receipt.timeout_ms, 30_000);
    tokio::time::advance(Duration::from_secs(11)).await;
    let batch = service.poll(poll(&instance)).await.unwrap();
    assert_eq!(batch.commands[0].remaining_ms, 19_000);
    tokio::time::advance(Duration::from_secs(19)).await;
    assert_eq!(
        service.command_result(&receipt.command_id).unwrap().state,
        CommandState::TimedOutUnconfirmed
    );
    assert!(
        service
            .poll(poll(&instance))
            .await
            .unwrap()
            .commands
            .is_empty()
    );
}

#[tokio::test(start_paused = true)]
async fn debugger_generation_changed_session_can_reselect_without_replaying_old_command() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let session = open(&service, &instance);
    let command = service.enqueue(request(&session)).unwrap();
    service.poll(poll(&instance)).await.unwrap();
    service
        .heartbeat(BridgeHeartbeat {
            instance_id: instance.instance_id.clone(),
            plugins: Some(vec![plugin("g2")]),
        })
        .unwrap();
    let mut next = target(&instance);
    next.generation = Some("g2".into());
    let selected = service.select_target(&session.session_id, next).unwrap();
    assert_eq!(selected.state, SessionState::Active);
    assert_eq!(selected.target.generation.as_deref(), Some("g2"));
    assert_eq!(
        service
            .acknowledge(ack(&instance, &command.command_id))
            .unwrap_err()
            .code,
        ErrorCode::ExpiredCommand
    );
    assert!(
        service
            .poll(poll(&instance))
            .await
            .unwrap()
            .commands
            .is_empty()
    );
    service.close_session(&session.session_id).unwrap();
    assert_eq!(
        service
            .select_target(&session.session_id, selected.target)
            .unwrap_err()
            .code,
        ErrorCode::InactiveSession
    );
}

#[tokio::test(start_paused = true)]
async fn debugger_reload_receipt_can_confirm_new_directory_without_accepting_old_inspect() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let session = open(&service, &instance);
    let old_read = service.enqueue(request(&session)).unwrap();
    let mut reload = request(&session);
    reload.tool = DebugTool::Reload;
    reload.parameters = json!({"confirmed":true});
    let reload = service.enqueue(reload).unwrap();
    service.poll(poll(&instance)).await.unwrap();
    service
        .heartbeat(BridgeHeartbeat {
            instance_id: instance.instance_id.clone(),
            plugins: Some(vec![]),
        })
        .unwrap();
    assert_eq!(
        service.session(&session.session_id).unwrap().state,
        SessionState::Active
    );
    assert!(
        service
            .poll(poll(&instance))
            .await
            .unwrap()
            .commands
            .is_empty()
    );
    assert_eq!(
        service.command_result(&reload.command_id).unwrap().state,
        CommandState::Delivered
    );
    service
        .heartbeat(BridgeHeartbeat {
            instance_id: instance.instance_id.clone(),
            plugins: Some(vec![plugin("g2")]),
        })
        .unwrap();
    let mut receipt = ack(&instance, &reload.command_id);
    receipt.response = json!({"status":"loaded","plugin_id":"test.plugin","generation":"g2"});
    assert_eq!(
        service.acknowledge(receipt).unwrap().state,
        CommandState::Succeeded
    );
    assert_eq!(
        service.session(&session.session_id).unwrap().state,
        SessionState::TargetChanged
    );
    assert!(
        service
            .acknowledge(ack(&instance, &old_read.command_id))
            .is_err()
    );
    let mut next = target(&instance);
    next.generation = Some("g2".into());
    let followed = service
        .follow_target(&session.session_id, &session.target, next.clone())
        .unwrap();
    assert_eq!(followed.unwrap().target.generation.as_deref(), Some("g2"));
    assert!(
        service
            .follow_target(&session.session_id, &session.target, next)
            .unwrap()
            .is_none()
    );
    assert!(
        service
            .poll(poll(&instance))
            .await
            .unwrap()
            .commands
            .is_empty()
    );
}

#[test]
fn debugger_follow_never_overwrites_explicit_selection_or_reopens_closed_session() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let second = register(&service);
    let session = open(&service, &instance);
    let selected = service
        .select_target(&session.session_id, target(&second))
        .unwrap();
    let mut next = session.target.clone();
    next.generation = Some("g2".into());
    assert!(
        service
            .follow_target(&session.session_id, &session.target, next.clone())
            .unwrap()
            .is_none()
    );
    assert_eq!(
        service.session(&session.session_id).unwrap().target,
        selected.target
    );
    service.close_session(&session.session_id).unwrap();
    assert!(
        service
            .follow_target(&session.session_id, &selected.target, next)
            .unwrap()
            .is_none()
    );
}

#[test]
fn debugger_server_changed_target_only_invalidates_old_generation_and_can_follow_explicitly() {
    let service = DebuggerService::new();
    let previous = DebugTarget {
        target_kind: TargetKind::Server,
        instance_id: None,
        plugin_id: "example".into(),
        generation: Some("g1".into()),
        version: None,
    };
    let first = service
        .open_session(SessionRequest {
            target: previous.clone(),
        })
        .unwrap();
    let old = service
        .open_session(SessionRequest {
            target: previous.clone(),
        })
        .unwrap();
    let next = DebugTarget {
        generation: Some("g2".into()),
        ..previous.clone()
    };
    let current = service
        .open_session(SessionRequest {
            target: next.clone(),
        })
        .unwrap();
    service.target_changed(&previous).unwrap();
    assert_eq!(
        service.session(&old.session_id).unwrap().state,
        SessionState::TargetChanged
    );
    assert_eq!(
        service.session(&current.session_id).unwrap().state,
        SessionState::Active
    );
    assert!(
        service
            .follow_target(&first.session_id, &previous, next)
            .unwrap()
            .is_some()
    );
    service.close_session(&old.session_id).unwrap();
    assert!(service.select_target(&old.session_id, previous).is_err());
}
