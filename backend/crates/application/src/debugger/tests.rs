//! 专项回归先于实现编写；共享工作区的 Cargo 执行由主代理串行调度。

use super::*;
use serde_json::json;
use std::{sync::Arc, time::Duration};

mod generations;
mod long_poll;

#[test]
fn short_state_contention_is_busy_not_exhausted_capacity() {
    let service = DebuggerService::new();
    let _held = service.state.lock().unwrap();
    let error = service.with_state(|_, _, _| Ok(())).unwrap_err();
    assert_eq!(error.code, ErrorCode::Busy);
}

fn plugin(generation: &str) -> BridgePlugin {
    BridgePlugin {
        plugin_id: "test.plugin".into(),
        generation: Some(generation.into()),
        version: Some("1.0.0".into()),
    }
}

fn register(service: &DebuggerService) -> BrowserInstance {
    service
        .register_instance(BridgeRegistration {
            plugins: vec![plugin("g1")],
        })
        .unwrap()
}

fn target(instance: &BrowserInstance) -> DebugTarget {
    DebugTarget {
        target_kind: TargetKind::Browser,
        instance_id: Some(instance.instance_id.clone()),
        plugin_id: "test.plugin".into(),
        generation: Some("g1".into()),
        version: None,
    }
}

fn open(service: &DebuggerService, instance: &BrowserInstance) -> DebugSession {
    service
        .open_session(SessionRequest {
            target: target(instance),
        })
        .unwrap()
}

fn request(session: &DebugSession) -> DebugCommandRequest {
    DebugCommandRequest {
        session_id: session.session_id.clone(),
        tool: DebugTool::Inspect,
        parameters: json!({}),
    }
}

fn poll(instance: &BrowserInstance) -> BridgePoll {
    BridgePoll {
        instance_id: instance.instance_id.clone(),
        limit: 4,
    }
}

fn ack(instance: &BrowserInstance, command_id: &str) -> BridgeAck {
    BridgeAck {
        instance_id: instance.instance_id.clone(),
        command_id: command_id.into(),
        plugin_id: "test.plugin".into(),
        generation: Some("g1".into()),
        success: true,
        response: json!({"ok": true}),
    }
}

#[tokio::test(start_paused = true)]
async fn debugger_poll_never_replays_and_receipts_are_instance_generation_bound() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let other = register(&service);
    assert_ne!(instance.instance_id, other.instance_id);
    assert!(uuid::Uuid::parse_str(&instance.instance_id).is_ok());
    let session = open(&service, &instance);
    let command = service.enqueue(request(&session)).unwrap();
    assert_eq!(
        service
            .acknowledge(ack(&instance, &command.command_id))
            .unwrap_err()
            .code,
        ErrorCode::NotDelivered
    );
    let first = service.poll(poll(&instance)).await.unwrap();
    assert_eq!(first.commands.len(), 1);
    assert!(
        service
            .poll(poll(&instance))
            .await
            .unwrap()
            .commands
            .is_empty()
    );
    assert_eq!(
        service
            .acknowledge(ack(&other, &command.command_id))
            .unwrap_err()
            .code,
        ErrorCode::WrongInstance
    );
    let mut stale = ack(&instance, &command.command_id);
    stale.generation = Some("g0".into());
    assert_eq!(
        service.acknowledge(stale).unwrap_err().code,
        ErrorCode::StaleTarget
    );
    assert_eq!(
        service
            .acknowledge(ack(&instance, &command.command_id))
            .unwrap()
            .state,
        CommandState::Succeeded
    );
    assert_eq!(
        service
            .acknowledge(ack(&instance, &command.command_id))
            .unwrap_err()
            .code,
        ErrorCode::DuplicateReceipt
    );
}

#[tokio::test(start_paused = true)]
async fn debugger_four_inflight_thirty_two_queued_and_close_releases_every_slot() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let session = open(&service, &instance);
    let commands: Vec<_> = (0..36)
        .map(|_| service.enqueue(request(&session)).unwrap())
        .collect();
    assert_eq!(
        service.enqueue(request(&session)).unwrap_err().code,
        ErrorCode::Capacity
    );
    assert_eq!(
        service.poll(poll(&instance)).await.unwrap().commands.len(),
        4
    );
    assert!(
        service
            .poll(poll(&instance))
            .await
            .unwrap()
            .commands
            .is_empty()
    );
    service
        .acknowledge(ack(&instance, &commands[0].command_id))
        .unwrap();
    assert_eq!(
        service.poll(poll(&instance)).await.unwrap().commands.len(),
        1
    );
    service.close_session(&session.session_id).unwrap();
    let status = service.poll(poll(&instance)).await.unwrap();
    assert!(status.active_sessions.is_empty());
    assert!(status.commands.is_empty());
    let next = open(&service, &instance);
    assert!(service.enqueue(request(&next)).is_ok());
}

#[tokio::test(start_paused = true)]
async fn debugger_read_action_deadlines_start_at_enqueue_and_late_ack_is_rejected() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let session = open(&service, &instance);
    let read = service.enqueue(request(&session)).unwrap();
    let mut action_input = request(&session);
    action_input.tool = DebugTool::UiAction;
    let action = service.enqueue(action_input).unwrap();
    assert_eq!(read.timeout_ms, 5_000);
    assert_eq!(action.timeout_ms, 10_000);
    service.poll(poll(&instance)).await.unwrap();
    tokio::time::advance(Duration::from_secs(5)).await;
    assert_eq!(
        service.command_result(&read.command_id).unwrap().state,
        CommandState::TimedOutUnconfirmed
    );
    assert_eq!(
        service
            .acknowledge(ack(&instance, &read.command_id))
            .unwrap_err()
            .code,
        ErrorCode::ExpiredCommand
    );
    assert_eq!(
        service.command_result(&action.command_id).unwrap().state,
        CommandState::Delivered
    );
    tokio::time::advance(Duration::from_secs(5)).await;
    assert_eq!(
        service.command_result(&action.command_id).unwrap().state,
        CommandState::TimedOutUnconfirmed
    );
}

#[tokio::test(start_paused = true)]
async fn debugger_instance_heartbeat_does_not_touch_sessions_and_instance_ttl_is_independent() {
    let config = DebuggerConfig {
        session_ttl: Duration::from_secs(3),
        instance_ttl: Duration::from_secs(2),
        ..Default::default()
    };
    let service = DebuggerService::with_config(config).unwrap();
    let instance = register(&service);
    let session = open(&service, &instance);
    tokio::time::advance(Duration::from_secs(1)).await;
    service
        .heartbeat(BridgeHeartbeat {
            instance_id: instance.instance_id.clone(),
            plugins: None,
        })
        .unwrap();
    service.touch_session(&session.session_id).unwrap();
    tokio::time::advance(Duration::from_secs(1)).await;
    service
        .heartbeat(BridgeHeartbeat {
            instance_id: instance.instance_id.clone(),
            plugins: None,
        })
        .unwrap();
    tokio::time::advance(Duration::from_secs(1)).await;
    service
        .heartbeat(BridgeHeartbeat {
            instance_id: instance.instance_id.clone(),
            plugins: None,
        })
        .unwrap();
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(
        service.session(&session.session_id).unwrap().state,
        SessionState::Expired
    );
    assert!(
        service
            .heartbeat(BridgeHeartbeat {
                instance_id: instance.instance_id.clone(),
                plugins: None
            })
            .unwrap()
            .active_sessions
            .is_empty()
    );
    tokio::time::advance(Duration::from_secs(2)).await;
    assert!(service.instances().unwrap().is_empty());
    assert_eq!(
        service
            .heartbeat(BridgeHeartbeat {
                instance_id: instance.instance_id,
                plugins: None
            })
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
}

#[test]
fn debugger_requires_registered_current_generation_and_bounded_directory() {
    let service = DebuggerService::new();
    let empty = service
        .register_instance(BridgeRegistration::default())
        .unwrap();
    assert_eq!(
        service
            .open_session(SessionRequest {
                target: target(&empty)
            })
            .unwrap_err()
            .code,
        ErrorCode::StaleTarget
    );
    let instance = register(&service);
    let mut missing = target(&instance);
    missing.generation = None;
    assert_eq!(
        service
            .open_session(SessionRequest { target: missing })
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    let mut stale = target(&instance);
    stale.generation = Some("g0".into());
    assert_eq!(
        service
            .open_session(SessionRequest { target: stale })
            .unwrap_err()
            .code,
        ErrorCode::StaleTarget
    );
    let session = open(&service, &instance);
    let command = service.enqueue(request(&session)).unwrap();
    service
        .heartbeat(BridgeHeartbeat {
            instance_id: instance.instance_id.clone(),
            plugins: Some(vec![plugin("g2")]),
        })
        .unwrap();
    assert_eq!(
        service.session(&session.session_id).unwrap().state,
        SessionState::TargetChanged
    );
    assert_eq!(
        service.command_result(&command.command_id).unwrap().state,
        CommandState::CancelledUnconfirmed
    );
    assert_eq!(
        service.targets().unwrap()[0].generation.as_deref(),
        Some("g2")
    );
}

#[tokio::test(start_paused = true)]
async fn debugger_execute_receives_real_ack_and_close_wakes_pending_waiter() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let session = open(&service, &instance);
    let (result, ()) = tokio::join!(biased; service.execute(request(&session)), async {
        let commands = service.poll(poll(&instance)).await.unwrap().commands;
        assert_eq!(commands.len(), 1);
        service.acknowledge(ack(&instance, &commands[0].command_id)).unwrap();
    });
    assert_eq!(result.unwrap().response, Some(json!({"ok": true})));
    let (result, ()) = tokio::join!(biased; service.execute(request(&session)), async {
        service.close_session(&session.session_id).unwrap();
    });
    assert_eq!(result.unwrap().state, CommandState::CancelledUnconfirmed);
    assert!(
        service
            .poll(poll(&instance))
            .await
            .unwrap()
            .active_sessions
            .is_empty()
    );
}

#[tokio::test(start_paused = true)]
async fn debugger_execute_timeout_does_not_claim_browser_stopped() {
    let config = DebuggerConfig {
        read_timeout: Duration::from_millis(5),
        ..Default::default()
    };
    let service = DebuggerService::with_config(config).unwrap();
    let instance = register(&service);
    let session = open(&service, &instance);
    let result = service.execute(request(&session)).await.unwrap();
    assert_eq!(result.state, CommandState::TimedOutUnconfirmed);
    assert!(result.response.is_none());
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
async fn debugger_disconnect_wakes_execute_and_does_not_affect_other_browser() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let other = register(&service);
    let session = open(&service, &instance);
    let other_session = open(&service, &other);
    service.enqueue(request(&other_session)).unwrap();
    let (result, ()) = tokio::join!(biased; service.execute(request(&session)), async {
        service.disconnect(&instance.instance_id).unwrap();
    });
    assert_eq!(result.unwrap().state, CommandState::CancelledUnconfirmed);
    assert_eq!(
        service.session(&session.session_id).unwrap().state,
        SessionState::Disconnected
    );
    assert_eq!(service.poll(poll(&other)).await.unwrap().commands.len(), 1);
    assert_eq!(service.instances().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn debugger_select_target_cancels_old_commands_without_closing_other_sessions() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let second_instance = register(&service);
    let session = open(&service, &instance);
    let other_session = open(&service, &instance);
    let command = service.enqueue(request(&session)).unwrap();
    service.enqueue(request(&other_session)).unwrap();
    service
        .select_target(&session.session_id, target(&second_instance))
        .unwrap();
    assert_eq!(
        service.command_result(&command.command_id).unwrap().state,
        CommandState::CancelledUnconfirmed
    );
    assert_eq!(
        service.poll(poll(&instance)).await.unwrap().commands.len(),
        1
    );
    service.enqueue(request(&session)).unwrap();
    assert_eq!(
        service
            .poll(poll(&second_instance))
            .await
            .unwrap()
            .commands
            .len(),
        1
    );
    assert_eq!(
        service.session(&session.session_id).unwrap().state,
        SessionState::Active
    );
}

#[test]
fn debugger_server_sessions_are_structural_only_and_browser_transport_rejects_them() {
    let service = DebuggerService::new();
    let target = DebugTarget {
        target_kind: TargetKind::Server,
        instance_id: None,
        plugin_id: "server.plugin".into(),
        generation: Some("g1".into()),
        version: None,
    };
    let session = service
        .open_session(SessionRequest {
            target: target.clone(),
        })
        .unwrap();
    assert_eq!(
        service.enqueue(request(&session)).unwrap_err().code,
        ErrorCode::UnsupportedTarget
    );
    assert!(service.targets().unwrap().is_empty());
    let mut invalid = target;
    invalid.instance_id = Some(uuid::Uuid::new_v4().to_string());
    assert_eq!(
        service
            .open_session(SessionRequest { target: invalid })
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
}

#[test]
fn debugger_instance_session_and_history_capacities_are_finite() {
    let config = DebuggerConfig {
        max_instances: 1,
        max_sessions: 1,
        max_session_history: 1,
        max_command_history: 1,
        ..Default::default()
    };
    let service = DebuggerService::with_config(config).unwrap();
    let instance = register(&service);
    assert_eq!(
        service
            .register_instance(BridgeRegistration::default())
            .unwrap_err()
            .code,
        ErrorCode::Capacity
    );
    let session = open(&service, &instance);
    assert_eq!(
        service
            .open_session(SessionRequest {
                target: target(&instance)
            })
            .unwrap_err()
            .code,
        ErrorCode::Capacity
    );
    let first_command = service.enqueue(request(&session)).unwrap();
    let second_command = service.enqueue(request(&session)).unwrap();
    service.close_session(&session.session_id).unwrap();
    let retained = [&first_command.command_id, &second_command.command_id]
        .into_iter()
        .filter(|id| service.command_result(id).is_ok())
        .count();
    assert_eq!(retained, 1);
    let next = open(&service, &instance);
    service.close_session(&next.session_id).unwrap();
    assert_eq!(
        service.session(&session.session_id).unwrap_err().code,
        ErrorCode::NotFound
    );
    assert_eq!(
        service.session(&next.session_id).unwrap().state,
        SessionState::Closed
    );
}

#[test]
fn debugger_event_retention_exposes_gap_and_filters_session_before_page_limit() {
    let config = DebuggerConfig {
        max_events: 4,
        ..Default::default()
    };
    let service = DebuggerService::with_config(config).unwrap();
    let instance = register(&service);
    let a = open(&service, &instance);
    let b = open(&service, &instance);
    service.enqueue(request(&a)).unwrap();
    service.enqueue(request(&b)).unwrap();
    let page = service
        .events(EventQuery {
            session_id: Some(b.session_id.clone()),
            after: 0,
            limit: 1,
        })
        .unwrap();
    assert_eq!(page.events.len(), 1);
    assert_eq!(page.events[0].session_id.as_ref(), Some(&b.session_id));
    assert_eq!(page.events[0].kind, EventKind::SessionOpened);
    assert!(page.gap);
    assert_eq!(page.dropped_events, 1);
    let next = service
        .events(EventQuery {
            session_id: Some(b.session_id),
            after: page.next_after,
            limit: 1,
        })
        .unwrap();
    assert_eq!(next.events[0].kind, EventKind::CommandQueued);
    assert_eq!(
        service
            .events(EventQuery {
                session_id: Some("missing".into()),
                after: 0,
                limit: 200
            })
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        service
            .events(EventQuery {
                session_id: None,
                after: 0,
                limit: 201
            })
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
}

#[test]
fn debugger_event_byte_budget_and_oversized_event_loss_are_visible() {
    let config = DebuggerConfig {
        max_event_bytes: 1,
        ..Default::default()
    };
    let service = DebuggerService::with_config(config).unwrap();
    register(&service);
    let page = service
        .events(EventQuery {
            session_id: None,
            after: 0,
            limit: 200,
        })
        .unwrap();
    assert!(page.events.is_empty());
    assert!(page.gap);
    assert_eq!(page.dropped_events, 1);
    assert_eq!(page.retained_bytes, 0);
    assert_eq!(page.next_after, page.latest_sequence);
    let config = DebuggerConfig {
        max_event_bytes: 700,
        ..Default::default()
    };
    let service = DebuggerService::with_config(config).unwrap();
    let instance = register(&service);
    let session = open(&service, &instance);
    for _ in 0..4 {
        service.enqueue(request(&session)).unwrap();
    }
    let page = service
        .events(EventQuery {
            session_id: None,
            after: 0,
            limit: 200,
        })
        .unwrap();
    assert!(page.retained_bytes <= 700);
    assert!(page.dropped_events > 0);
    assert!(page.gap);
}

#[tokio::test(start_paused = true)]
async fn debugger_dropped_execute_future_is_not_delivered_later() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let session = open(&service, &instance);
    let mut waiting = Box::pin(service.execute(request(&session)));
    assert!(futures_util::poll!(&mut waiting).is_pending());
    drop(waiting);
    assert!(
        service
            .poll(poll(&instance))
            .await
            .unwrap()
            .commands
            .is_empty()
    );
    let page = service
        .events(EventQuery {
            session_id: Some(session.session_id),
            after: 0,
            limit: 200,
        })
        .unwrap();
    assert!(
        page.events
            .iter()
            .any(|event| event.command_state == Some(CommandState::CancelledUnconfirmed))
    );
}

#[test]
fn debugger_manual_clock_reaps_expired_state_on_observation_without_background_work() {
    use std::sync::atomic::{AtomicU64, Ordering};
    struct Clock(AtomicU64);
    impl DebuggerClock for Clock {
        fn now(&self) -> Duration {
            Duration::from_millis(self.0.load(Ordering::Relaxed))
        }
    }
    let clock = Arc::new(Clock(AtomicU64::new(0)));
    let config = DebuggerConfig {
        session_ttl: Duration::from_millis(20),
        ..Default::default()
    };
    let service = DebuggerService::with_clock(config, clock.clone()).unwrap();
    let instance = register(&service);
    let session = open(&service, &instance);
    clock.0.store(20, Ordering::Relaxed);
    assert_eq!(
        service.session(&session.session_id).unwrap().state,
        SessionState::Expired
    );
}

#[tokio::test(start_paused = true)]
async fn debugger_response_accepts_500_ui_nodes_and_source_code_but_not_credentials() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let session = open(&service, &instance);
    let command = service.enqueue(request(&session)).unwrap();
    service.poll(poll(&instance)).await.unwrap();
    let nodes: Vec<_> = (0..500)
        .map(|n| {
            let mut fields = serde_json::Map::new();
            for field in 0..20 {
                fields.insert(format!("field_{field}"), json!(n));
            }
            serde_json::Value::Object(fields)
        })
        .collect();
    let mut receipt = ack(&instance, &command.command_id);
    receipt.response =
        json!({"nodes": nodes, "coverage": {"source": "host"}, "error": {"code": "unsupported"}});
    assert!(service.acknowledge(receipt).is_ok());
    let command = service.enqueue(request(&session)).unwrap();
    service.poll(poll(&instance)).await.unwrap();
    let mut too_many = ack(&instance, &command.command_id);
    too_many.response = json!({"nodes": vec![json!({"id":"node"}); 501]});
    assert_eq!(
        service.acknowledge(too_many).unwrap_err().code,
        ErrorCode::Capacity
    );
    let mut secret = ack(&instance, &command.command_id);
    secret.response = json!({"nested": {"api_key":"不可记录"}});
    assert_eq!(
        service.acknowledge(secret).unwrap_err().code,
        ErrorCode::InvalidInput
    );
    assert_eq!(
        service.command_result(&command.command_id).unwrap().state,
        CommandState::Delivered
    );
}

#[tokio::test(start_paused = true)]
async fn debugger_request_64k_response_1m_and_history_bytes_are_separate_budgets() {
    let config = DebuggerConfig {
        max_result_bytes: 100_000,
        ..Default::default()
    };
    let service = DebuggerService::with_config(config).unwrap();
    let instance = register(&service);
    let session = open(&service, &instance);
    let mut oversized = request(&session);
    oversized.parameters = json!({"value": "a".repeat(64 * 1024)});
    assert_eq!(
        service.enqueue(oversized).unwrap_err().code,
        ErrorCode::Capacity
    );
    let mut ids = Vec::new();
    for _ in 0..2 {
        let command = service.enqueue(request(&session)).unwrap();
        service.poll(poll(&instance)).await.unwrap();
        let mut response = ack(&instance, &command.command_id);
        response.response = json!({"value": "a".repeat(80_000)});
        service.acknowledge(response).unwrap();
        ids.push(command.command_id);
    }
    assert_eq!(
        service.command_result(&ids[0]).unwrap_err().code,
        ErrorCode::NotFound
    );
    assert_eq!(
        service.command_result(&ids[1]).unwrap().state,
        CommandState::Succeeded
    );
    let command = service.enqueue(request(&session)).unwrap();
    service.poll(poll(&instance)).await.unwrap();
    let mut oversized = ack(&instance, &command.command_id);
    oversized.response = json!({"value": "a".repeat(1024 * 1024)});
    assert_eq!(
        service.acknowledge(oversized).unwrap_err().code,
        ErrorCode::Capacity
    );
}

#[test]
fn debugger_public_contracts_reject_unknown_fields_and_only_whitelist_tools() {
    assert!(serde_json::from_value::<BridgeRegistration>(json!({"url":"not_allowed"})).is_err());
    assert!(
        serde_json::from_value::<DebugCommandRequest>(
            json!({"session_id":"s", "tool":"eval", "parameters":{}})
        )
        .is_err()
    );
    for name in [
        "inspect",
        "ui_tree",
        "ui_query",
        "ui_diff",
        "ui_assert",
        "ui_action",
        "invoke",
        "reload",
        "report",
    ] {
        assert!(
            serde_json::from_value::<DebugCommandRequest>(
                json!({"session_id":"s", "tool":name, "parameters":{}})
            )
            .is_ok()
        );
    }
    assert!(schemars::schema_for!(SessionRequest).as_value().is_object());
    assert!(schemars::schema_for!(BridgePoll).as_value().is_object());
    assert!(schemars::schema_for!(BridgeAck).as_value().is_object());
    assert!(
        schemars::schema_for!(DebugCommandResult)
            .as_value()
            .is_object()
    );
}
