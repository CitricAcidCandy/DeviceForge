//! 实时桥直接驱动调试状态机；手动时钟沿用既有测试模式，不等待真实时间。

use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
struct FakeClock(AtomicU64);

impl DebuggerClock for FakeClock {
    fn now(&self) -> Duration {
        Duration::from_millis(self.0.load(Ordering::Relaxed))
    }
}

impl FakeClock {
    fn advance(&self, milliseconds: u64) {
        self.0.fetch_add(milliseconds, Ordering::Relaxed);
    }
}

fn fixture() -> (Arc<FakeClock>, DebuggerService) {
    fixture_with(DebuggerConfig::default())
}

#[tokio::test(start_paused = true)]
async fn readonly_unlock_wakes_contenders_without_emitting_business_change() {
    let (_, service) = fixture();
    let (lease, _) = connect(&service, "reader-owner");
    let available = service.realtime_unlocked();
    let changed = service.realtime_changed();
    tokio::pin!(available, changed);
    available.as_mut().enable();
    changed.as_mut().enable();
    service.realtime_status(&lease).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(1), available)
            .await
            .is_ok()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(1), changed)
            .await
            .is_err()
    );
}

fn fixture_with(config: DebuggerConfig) -> (Arc<FakeClock>, DebuggerService) {
    let clock = Arc::new(FakeClock::default());
    let service = DebuggerService::with_clock(config, clock.clone()).unwrap();
    (clock, service)
}

fn plugin() -> BridgePlugin {
    BridgePlugin {
        plugin_id: "test.plugin".into(),
        generation: Some("g1".into()),
        version: Some("1.0.0".into()),
    }
}

fn connect(service: &DebuggerService, owner: &str) -> (BridgeLease, BridgeOpened) {
    service
        .realtime_open(
            owner,
            BridgeOpen {
                plugins: vec![plugin()],
                ..Default::default()
            },
        )
        .unwrap()
}

fn resume(
    service: &DebuggerService,
    owner: &str,
    opened: &BridgeOpened,
    inflight: Vec<String>,
) -> Result<(BridgeLease, BridgeOpened)> {
    service.realtime_open(
        owner,
        BridgeOpen {
            instance_id: Some(opened.instance_id.clone()),
            resume_key: Some(opened.resume_key.clone()),
            plugins: vec![plugin()],
            inflight,
        },
    )
}

fn session(service: &DebuggerService, opened: &BridgeOpened) -> DebugSession {
    service
        .open_session(SessionRequest {
            target: opened.status.targets[0].clone(),
        })
        .unwrap()
}

fn enqueue(service: &DebuggerService, session: &DebugSession) -> DebugCommandReceipt {
    service
        .enqueue(DebugCommandRequest {
            session_id: session.session_id.clone(),
            tool: DebugTool::Inspect,
            parameters: json!({}),
        })
        .unwrap()
}

fn ack(lease: &BridgeLease, command_id: &str, success: bool) -> BridgeAck {
    BridgeAck {
        instance_id: lease.instance_id.clone(),
        command_id: command_id.into(),
        plugin_id: "test.plugin".into(),
        generation: Some("g1".into()),
        success,
        response: json!({"ok": success}),
    }
}

#[test]
fn open_reuses_live_owner_and_online_instance_does_not_expire_without_heartbeats() {
    let (clock, service) = fixture();
    let (lease, opened) = connect(&service, "connection-1");
    assert!(uuid::Uuid::parse_str(&opened.instance_id).is_ok());
    assert!(!opened.resume_key.is_empty());
    assert!(opened.commands.is_empty());
    assert_eq!(opened.status.targets.len(), 1);
    let active = session(&service, &opened);

    let (same_lease, same) = connect(&service, "connection-1");
    assert_eq!(same.instance_id, opened.instance_id);
    assert_eq!(same.resume_key, opened.resume_key);
    assert_eq!(service.instances().unwrap().len(), 1);

    clock.advance(120_000);
    let status = service.realtime_status(&lease).unwrap();
    assert_eq!(status.instance_id, opened.instance_id);
    assert_eq!(status.active_sessions[0].session_id, active.session_id);
    assert!(service.realtime_status(&same_lease).is_ok());
}

#[test]
fn resume_before_sixty_seconds_preserves_instance_and_session() {
    let (clock, service) = fixture();
    let (old, opened) = connect(&service, "connection-1");
    let active = session(&service, &opened);
    // 恢复期限从断线开始，不能从登记或最近一次目录上报开始。
    clock.advance(120_000);
    service.realtime_detach(&old).unwrap();
    assert_eq!(
        service.realtime_status(&old).unwrap_err().code,
        ErrorCode::WrongInstance
    );
    clock.advance(59_999);

    let (new, resumed) = resume(&service, "connection-2", &opened, vec![]).unwrap();
    assert_eq!(resumed.instance_id, opened.instance_id);
    assert_eq!(resumed.resume_key, opened.resume_key);
    assert_eq!(resumed.status.active_sessions.len(), 1);
    assert_eq!(
        resumed.status.active_sessions[0].session_id,
        active.session_id
    );
    assert_eq!(
        service.session(&active.session_id).unwrap().state,
        SessionState::Active
    );
    assert!(service.realtime_status(&new).is_ok());
    assert_eq!(
        service.realtime_status(&old).unwrap_err().code,
        ErrorCode::WrongInstance
    );
}

#[test]
fn resume_at_sixty_seconds_expires_old_instance_and_allows_new_work() {
    let (clock, service) = fixture();
    let (old, opened) = connect(&service, "connection-1");
    let active = session(&service, &opened);
    clock.advance(120_000);
    service.realtime_detach(&old).unwrap();
    clock.advance(60_000);

    let failure = resume(&service, "connection-2", &opened, vec![])
        .err()
        .unwrap();
    assert_eq!(failure.code, ErrorCode::NotFound);
    assert!(service.instances().unwrap().is_empty());
    assert_eq!(
        service.session(&active.session_id).unwrap().state,
        SessionState::Disconnected
    );

    let (new, fresh) = connect(&service, "connection-2");
    assert_ne!(fresh.instance_id, opened.instance_id);
    let next = session(&service, &fresh);
    let command = enqueue(&service, &next);
    let (batch, _) = service.realtime_batch(&new, 4).unwrap();
    assert_eq!(batch.commands.len(), 1);
    assert_eq!(batch.commands[0].command_id, command.command_id);
}

#[test]
fn repeated_detach_does_not_restart_sixty_second_restore_window() {
    let (clock, service) = fixture();
    let (old, opened) = connect(&service, "connection-1");
    service.realtime_detach(&old).unwrap();
    clock.advance(59_000);
    service.realtime_detach(&old).unwrap();
    clock.advance(1_000);

    let failure = resume(&service, "connection-2", &opened, vec![])
        .err()
        .unwrap();
    assert_eq!(failure.code, ErrorCode::NotFound);
    assert!(service.instances().unwrap().is_empty());
}

#[test]
fn resume_reconciles_delivered_command_without_replaying_it() {
    let (clock, service) = fixture();
    let (old, opened) = connect(&service, "connection-1");
    let active = session(&service, &opened);
    let delivered = service
        .enqueue(DebugCommandRequest {
            session_id: active.session_id.clone(),
            tool: DebugTool::Invoke,
            parameters: json!({
                "kind": "command",
                "id": "test.action",
                "input": {},
                "confirmed": true,
                "allow_unknown_side_effects": true
            }),
        })
        .unwrap();
    let pending = enqueue(&service, &active);
    let (first, _) = service.realtime_batch(&old, 1).unwrap();
    assert_eq!(first.commands.len(), 1);
    assert_eq!(first.commands[0].command_id, delivered.command_id);
    clock.advance(1_000);
    service.realtime_detach(&old).unwrap();

    let (new, resumed) = resume(
        &service,
        "connection-2",
        &opened,
        vec![delivered.command_id.clone()],
    )
    .unwrap();
    assert_eq!(resumed.commands.len(), 1);
    assert_eq!(resumed.commands[0].command_id, delivered.command_id);
    assert_eq!(resumed.commands[0].state, CommandState::Delivered);
    assert!(resumed.commands[0].response.is_none());
    let (next, _) = service.realtime_batch(&new, 4).unwrap();
    assert_eq!(next.commands.len(), 1);
    assert_eq!(next.commands[0].command_id, pending.command_id);
    assert_eq!(next.commands[0].remaining_ms, 4_000);
    assert!(
        service
            .realtime_batch(&new, 4)
            .unwrap()
            .0
            .commands
            .is_empty()
    );
    assert_eq!(
        service
            .realtime_acknowledge(&old, ack(&old, &delivered.command_id, true))
            .unwrap_err()
            .code,
        ErrorCode::WrongInstance
    );
    assert_eq!(
        service
            .realtime_acknowledge(&new, ack(&new, &delivered.command_id, true))
            .unwrap()
            .state,
        CommandState::Succeeded
    );
}

#[test]
fn resume_does_not_restart_delivered_or_pending_command_deadlines() {
    let (clock, service) = fixture();
    let (old, opened) = connect(&service, "connection-1");
    let active = session(&service, &opened);
    let delivered = enqueue(&service, &active);
    let pending = enqueue(&service, &active);
    assert_eq!(service.realtime_batch(&old, 1).unwrap().0.commands.len(), 1);
    clock.advance(2_000);
    service.realtime_detach(&old).unwrap();
    clock.advance(2_000);

    let (new, _) = resume(
        &service,
        "connection-2",
        &opened,
        vec![delivered.command_id.clone()],
    )
    .unwrap();
    let (batch, remaining) = service.realtime_batch(&new, 4).unwrap();
    assert_eq!(batch.commands.len(), 1);
    assert_eq!(batch.commands[0].command_id, pending.command_id);
    assert_eq!(batch.commands[0].remaining_ms, 1_000);
    assert_eq!(remaining, Duration::from_millis(1_000));

    clock.advance(999);
    for command in [&delivered, &pending] {
        assert_eq!(
            service.command_result(&command.command_id).unwrap().state,
            CommandState::Delivered
        );
    }
    clock.advance(1);
    for command in [&delivered, &pending] {
        assert_eq!(
            service.command_result(&command.command_id).unwrap().state,
            CommandState::TimedOutUnconfirmed
        );
        assert_eq!(
            service
                .realtime_acknowledge(&new, ack(&new, &command.command_id, true))
                .unwrap_err()
                .code,
            ErrorCode::ExpiredCommand
        );
        assert!(
            service
                .command_result(&command.command_id)
                .unwrap()
                .response
                .is_none()
        );
    }
    assert!(
        service
            .realtime_batch(&new, 4)
            .unwrap()
            .0
            .commands
            .is_empty()
    );
}

#[test]
fn resume_does_not_extend_original_session_deadline() {
    let (clock, service) = fixture_with(DebuggerConfig {
        session_ttl: Duration::from_secs(5),
        ..Default::default()
    });
    let (old, opened) = connect(&service, "connection-1");
    let active = session(&service, &opened);
    clock.advance(2_000);
    service.realtime_detach(&old).unwrap();
    clock.advance(2_000);
    let (new, resumed) = resume(&service, "connection-2", &opened, vec![]).unwrap();
    assert_eq!(resumed.status.active_sessions.len(), 1);

    clock.advance(1_000);
    assert_eq!(
        service.session(&active.session_id).unwrap().state,
        SessionState::Expired
    );
    assert!(
        service
            .realtime_status(&new)
            .unwrap()
            .active_sessions
            .is_empty()
    );
}

#[test]
fn old_lease_detach_never_releases_new_owner_or_same_owner_generation() {
    for owner in ["connection-2", "connection-1"] {
        let (clock, service) = fixture();
        let (old, opened) = connect(&service, "connection-1");
        let active = session(&service, &opened);
        service.realtime_detach(&old).unwrap();
        clock.advance(1);
        let (new, _) = resume(&service, owner, &opened, vec![]).unwrap();

        service.realtime_detach(&old).unwrap();
        clock.advance(60_001);
        assert!(service.realtime_status(&new).is_ok());
        assert_eq!(
            service.realtime_status(&old).unwrap_err().code,
            ErrorCode::WrongInstance
        );
        assert_eq!(
            service
                .realtime_close(&old, &opened.instance_id)
                .unwrap_err()
                .code,
            ErrorCode::WrongInstance
        );
        let command = enqueue(&service, &active);
        let (batch, _) = service.realtime_batch(&new, 4).unwrap();
        assert_eq!(batch.commands.len(), 1);
        assert_eq!(batch.commands[0].command_id, command.command_id);
        assert!(
            service
                .realtime_acknowledge(&new, ack(&new, &command.command_id, true))
                .is_ok()
        );
    }
}

#[tokio::test(start_paused = true)]
async fn http_cannot_claim_or_acknowledge_ws_instance_but_legacy_instance_still_works() {
    let (_, service) = fixture();
    let (lease, opened) = connect(&service, "connection-1");
    let active = session(&service, &opened);
    let command = enqueue(&service, &active);
    assert_eq!(
        service
            .poll(BridgePoll {
                instance_id: opened.instance_id.clone(),
                limit: 4
            })
            .await
            .unwrap_err()
            .code,
        ErrorCode::WrongInstance
    );
    assert_eq!(
        service.command_result(&command.command_id).unwrap().state,
        CommandState::Queued
    );
    assert_eq!(
        service
            .heartbeat(BridgeHeartbeat {
                instance_id: opened.instance_id.clone(),
                plugins: None
            })
            .unwrap_err()
            .code,
        ErrorCode::WrongInstance
    );
    let (batch, _) = service.realtime_batch(&lease, 4).unwrap();
    assert_eq!(batch.commands.len(), 1);
    assert_eq!(batch.commands[0].command_id, command.command_id);
    assert_eq!(
        service
            .acknowledge(ack(&lease, &command.command_id, true))
            .unwrap_err()
            .code,
        ErrorCode::WrongInstance
    );
    assert_eq!(
        service.command_result(&command.command_id).unwrap().state,
        CommandState::Delivered
    );
    assert!(
        service
            .realtime_acknowledge(&lease, ack(&lease, &command.command_id, true))
            .is_ok()
    );

    let legacy = service
        .register_instance(BridgeRegistration {
            plugins: vec![plugin()],
        })
        .unwrap();
    let legacy_session = service
        .open_session(SessionRequest {
            target: DebugTarget {
                target_kind: TargetKind::Browser,
                instance_id: Some(legacy.instance_id.clone()),
                plugin_id: "test.plugin".into(),
                generation: Some("g1".into()),
                version: None,
            },
        })
        .unwrap();
    let legacy_command = enqueue(&service, &legacy_session);
    let legacy_batch = service
        .poll(BridgePoll {
            instance_id: legacy.instance_id.clone(),
            limit: 4,
        })
        .await
        .unwrap();
    assert_eq!(legacy_batch.commands.len(), 1);
    assert_eq!(
        legacy_batch.commands[0].command_id,
        legacy_command.command_id
    );
    let mut legacy_ack = ack(&lease, &legacy_command.command_id, true);
    legacy_ack.instance_id = legacy.instance_id;
    assert_eq!(
        service.acknowledge(legacy_ack).unwrap().state,
        CommandState::Succeeded
    );
}

#[test]
fn repeated_receipt_and_resume_never_change_terminal_state_or_reemit_result_body() {
    for success in [true, false] {
        let (_, service) = fixture();
        let (old, opened) = connect(&service, "connection-1");
        let active = session(&service, &opened);
        let command = enqueue(&service, &active);
        service.realtime_batch(&old, 4).unwrap();
        let receipt = ack(&old, &command.command_id, success);
        let expected_state = if success {
            CommandState::Succeeded
        } else {
            CommandState::Failed
        };
        assert_eq!(
            service
                .realtime_acknowledge(&old, receipt.clone())
                .unwrap()
                .state,
            expected_state
        );
        let terminal =
            serde_json::to_value(service.command_result(&command.command_id).unwrap()).unwrap();
        assert_eq!(
            service
                .realtime_acknowledge(&old, receipt.clone())
                .unwrap()
                .state,
            expected_state
        );

        let mut conflicting_body = receipt.clone();
        conflicting_body.response = json!({"ok": success, "different": true});
        assert_eq!(
            service
                .realtime_acknowledge(&old, conflicting_body)
                .unwrap_err()
                .code,
            ErrorCode::DuplicateReceipt
        );
        assert_eq!(
            service
                .realtime_acknowledge(&old, ack(&old, &command.command_id, !success))
                .unwrap_err()
                .code,
            ErrorCode::DuplicateReceipt
        );
        service.realtime_detach(&old).unwrap();
        let (new, resumed) = resume(
            &service,
            "connection-2",
            &opened,
            vec![command.command_id.clone()],
        )
        .unwrap();
        assert_eq!(resumed.commands.len(), 1);
        assert_eq!(resumed.commands[0].command_id, command.command_id);
        assert_eq!(resumed.commands[0].state, expected_state);
        // 恢复握手只核对状态，完整结果继续由原命令查询提供。
        assert!(resumed.commands[0].response.is_none());
        assert_eq!(
            service.realtime_acknowledge(&new, receipt).unwrap().state,
            expected_state
        );
        assert_eq!(
            serde_json::to_value(service.command_result(&command.command_id).unwrap()).unwrap(),
            terminal
        );
        assert!(
            service
                .realtime_batch(&new, 4)
                .unwrap()
                .0
                .commands
                .is_empty()
        );

        let events = service
            .events(EventQuery {
                session_id: Some(active.session_id),
                after: 0,
                limit: 200,
            })
            .unwrap();
        assert_eq!(
            events
                .events
                .iter()
                .filter(|event| {
                    event.kind == EventKind::CommandFinished
                        && event.command_id.as_deref() == Some(command.command_id.as_str())
                })
                .count(),
            1
        );
    }
}

#[test]
fn invalid_resume_never_takes_over_existing_lease_or_changes_plugin_generation() {
    let (_, service) = fixture();
    let (lease, opened) = connect(&service, "connection-1");
    let active = session(&service, &opened);
    let command = enqueue(&service, &active);
    let (_, other) = connect(&service, "other-connection");
    let other_session = session(&service, &other);
    let foreign = enqueue(&service, &other_session);

    let mut wrong_key = opened.clone();
    wrong_key.resume_key = "invalid-resume-key".into();
    assert_eq!(
        resume(&service, "connection-2", &wrong_key, vec![])
            .err()
            .unwrap()
            .code,
        ErrorCode::WrongInstance
    );
    let failure = service
        .realtime_open(
            "connection-2",
            BridgeOpen {
                instance_id: Some(opened.instance_id.clone()),
                resume_key: Some(opened.resume_key.clone()),
                plugins: vec![BridgePlugin {
                    generation: Some("g2".into()),
                    ..plugin()
                }],
                inflight: vec![command.command_id.clone(), foreign.command_id],
            },
        )
        .err()
        .unwrap();
    assert_eq!(failure.code, ErrorCode::WrongInstance);
    assert_eq!(
        service.realtime_status(&lease).unwrap().targets[0]
            .generation
            .as_deref(),
        Some("g1")
    );
    assert_eq!(
        service.session(&active.session_id).unwrap().state,
        SessionState::Active
    );
    let (batch, _) = service.realtime_batch(&lease, 4).unwrap();
    assert_eq!(batch.commands.len(), 1);
    assert_eq!(batch.commands[0].command_id, command.command_id);
}

#[test]
fn legal_large_commands_are_split_by_frame_budget_without_loss_or_redelivery() {
    let (_, service) = fixture();
    let (lease, opened) = connect(&service, "connection-1");
    let active = session(&service, &opened);
    let steps: Vec<_> = (0..12)
        .map(|index| {
            json!({
                "id": format!("step-{index}"),
                "tool": "invoke",
                "parameters": {
                    "kind": "command",
                    "id": "test.large-input",
                    "input": {"text": "a".repeat(48 * 1024)},
                    "confirmed": true,
                    "allow_unknown_side_effects": true
                }
            })
        })
        .collect();
    let request = DebugCommandRequest {
        session_id: active.session_id,
        tool: DebugTool::AutomationRun,
        parameters: json!({"confirmed": true, "steps": steps}),
    };
    let first = service.enqueue(request.clone()).unwrap();
    let second = service.enqueue(request).unwrap();

    // 单条合法，但两条合并超过传输上限；未装入本帧的命令必须仍能领取。
    let (first_batch, _) = service.realtime_batch(&lease, 4).unwrap();
    assert_eq!(first_batch.commands.len(), 1);
    assert_eq!(first_batch.commands[0].command_id, first.command_id);
    let encoded = serde_json::to_vec(&first_batch).unwrap();
    assert!(encoded.len() > 512 * 1024);
    assert!(encoded.len() <= 1024 * 1024 + 16 * 1024);
    assert_eq!(
        service.command_result(&second.command_id).unwrap().state,
        CommandState::Queued
    );

    let (second_batch, _) = service.realtime_batch(&lease, 4).unwrap();
    assert_eq!(second_batch.commands.len(), 1);
    assert_eq!(second_batch.commands[0].command_id, second.command_id);
    assert!(serde_json::to_vec(&second_batch).unwrap().len() <= 1024 * 1024 + 16 * 1024);
    assert!(
        service
            .realtime_batch(&lease, 4)
            .unwrap()
            .0
            .commands
            .is_empty()
    );
    for command in [&first, &second] {
        assert_eq!(
            service.command_result(&command.command_id).unwrap().state,
            CommandState::Delivered
        );
    }
}

#[test]
fn resume_summarizes_four_large_results_without_losing_original_command_history() {
    let (_, service) = fixture();
    let (old, opened) = connect(&service, "connection-1");
    let active = session(&service, &opened);
    let commands: Vec<_> = (0..4).map(|_| enqueue(&service, &active)).collect();
    assert_eq!(service.realtime_batch(&old, 4).unwrap().0.commands.len(), 4);
    let response = json!({"text": "a".repeat(300 * 1024)});
    assert!(serde_json::to_vec(&response).unwrap().len() * 4 > 1024 * 1024 + 16 * 1024);
    for command in &commands {
        let mut receipt = ack(&old, &command.command_id, true);
        receipt.response = response.clone();
        service.realtime_acknowledge(&old, receipt).unwrap();
    }
    service.realtime_detach(&old).unwrap();

    let (new, resumed) = resume(
        &service,
        "connection-2",
        &opened,
        commands
            .iter()
            .map(|command| command.command_id.clone())
            .collect(),
    )
    .unwrap();
    assert_eq!(resumed.commands.len(), 4);
    // 四份正文合计超过单帧预算，恢复不能重新附带正文或删掉原查询结果。
    assert!(serde_json::to_vec(&resumed).unwrap().len() <= 16 * 1024);
    for (summary, command) in resumed.commands.iter().zip(&commands) {
        assert_eq!(summary.command_id, command.command_id);
        assert_eq!(summary.state, CommandState::Succeeded);
        assert!(summary.response.is_none());
        assert_eq!(
            service
                .command_result(&command.command_id)
                .unwrap()
                .response,
            Some(response.clone())
        );
    }
    assert!(
        service
            .realtime_batch(&new, 4)
            .unwrap()
            .0
            .commands
            .is_empty()
    );
}
