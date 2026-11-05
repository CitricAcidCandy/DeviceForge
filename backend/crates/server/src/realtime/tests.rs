//! 只验证内存状态、真实准入函数和关闭句柄；不监听端口、不连接浏览器。

use super::{
    lifecycle::Lifecycle,
    outbox::{Lane, Queue, merge_task_notice, message_bytes},
    retry::BusyRetry,
    *,
};
use apk_application::debugger::*;
use axum::{http::StatusCode, response::IntoResponse};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn physical_quota_is_independent_and_http_upgrade_releases_ordinary_permit() {
    let runtime = Lifecycle::new(CancellationToken::new());
    let connections: Vec<_> = (0..MAX_CONNECTIONS)
        .map(|_| runtime.admit().unwrap())
        .collect();
    assert!(runtime.admit().is_none());
    let ordinary = Arc::new(Semaphore::new(1));
    let permit = ordinary.clone().try_acquire_owned().unwrap();
    let response = finish_http_request(StatusCode::SWITCHING_PROTOCOLS.into_response(), permit);
    assert_eq!(ordinary.available_permits(), 1);
    assert_eq!(runtime.slots.available_permits(), 0);
    connections[0].close().await;
    assert_eq!(runtime.slots.available_permits(), 1);
    assert!(!connections[1].stopping.is_cancelled());
    assert!(runtime.admit().is_some());
    drop(response);
    runtime.close().await;
}

#[test]
fn ordinary_response_keeps_its_permit_until_response_is_dropped() {
    let ordinary = Arc::new(Semaphore::new(1));
    let permit = ordinary.clone().try_acquire_owned().unwrap();
    let response = finish_http_request(StatusCode::OK.into_response(), permit);
    assert_eq!(ordinary.available_permits(), 0);
    drop(response);
    assert_eq!(ordinary.available_permits(), 1);
}

#[test]
fn lane_admission_reserves_capacity_and_counts_inflight_packets() {
    let mut queue = Queue::default();
    for number in 0..6 {
        assert!(queue.reserve(Lane::Debugger, 10));
        queue.push(Lane::Debugger, number, 10);
    }
    assert!(!queue.reserve(Lane::Debugger, 10));
    assert!(queue.reserve(Lane::Tasks, 10));
    queue.push(Lane::Tasks, 9, 10);
    let (lane, _, bytes) = queue.pop().unwrap();
    assert_eq!(lane, Lane::Debugger);
    // 已出队但未完成的消息仍占额度，不能瞬间突破包数上限。
    assert!(!queue.reserve(Lane::Debugger, 10));
    queue.release(lane, bytes);
    assert!(queue.reserve(Lane::Debugger, 10));
    assert_eq!(queue.pop().unwrap().0, Lane::Tasks);
}

#[test]
fn lane_byte_quota_and_single_lane_fifo_are_bounded() {
    let mut queue = Queue::default();
    assert!(!queue.reserve(Lane::Tasks, 1024 * 1024 + 1));
    assert!(queue.reserve(Lane::Tasks, 1));
    queue.push(Lane::Tasks, 7, 1);
    assert_eq!(queue.pop().unwrap().1, 7);
    assert!(queue.reserve(Lane::Debugger, 1));
    queue.push(Lane::Debugger, 1, 1);
    assert!(queue.reserve(Lane::Debugger, 1));
    queue.push(Lane::Debugger, 2, 1);
    assert_eq!(queue.pop().unwrap().1, 1);
    assert_eq!(queue.pop().unwrap().1, 2);
}

#[test]
fn message_limit_includes_frame_headroom() {
    let value = json!("a".repeat(MAX_MESSAGE_BYTES - 130));
    assert!(message_bytes(&value).is_ok());
    let too_large = json!("a".repeat(MAX_MESSAGE_BYTES - 129));
    assert!(message_bytes(&too_large).is_err());
}

#[test]
fn task_coalescing_keeps_latest_revision_and_sticky_reset() {
    let first = json!({"log_id":"first","data":{"revision":"1","reset":true}});
    let mut latest = json!({"log_id":"latest","data":{"revision":"8","reset":false}});
    merge_task_notice(&first, &mut latest);
    assert_eq!(latest["data"]["revision"], "8");
    assert_eq!(latest["data"]["reset"], true);
    assert_eq!(latest["log_id"], "latest");
}

#[test]
fn busy_retry_is_bounded_by_original_deadline_and_does_not_require_disconnect() {
    let now = tokio::time::Instant::now();
    let deadline = now + Duration::from_millis(12);
    let mut retry = BusyRetry::default();
    assert_eq!(
        retry.delay(now, Some(deadline)),
        Some(Duration::from_millis(5))
    );
    assert_eq!(
        retry.delay(now + Duration::from_millis(5), Some(deadline)),
        Some(Duration::from_millis(7))
    );
    assert!(retry.delay(deadline, Some(deadline)).is_none());
    // 没有原命令时也只短退避，耗尽后由生产泵等待真实变化，而非断开连接。
    retry.reset();
    assert!(retry.delay(now, None).is_some());
    assert!(
        retry
            .delay(now + Duration::from_millis(250), None)
            .is_none()
    );
}

#[tokio::test]
async fn one_namespace_leaving_preserves_the_other_and_last_leave_closes_owner() {
    let runtime = Lifecycle::new(CancellationToken::new());
    let resources = runtime.admit().unwrap();
    assert!(resources.attach(Lane::Debugger));
    assert!(resources.attach(Lane::Tasks));
    resources.outbox.stop_lane(Lane::Debugger);
    resources.detached(Lane::Debugger).await;
    assert!(!resources.stopping.is_cancelled());
    assert_eq!(runtime.slots.available_permits(), MAX_CONNECTIONS - 1);
    resources.detached(Lane::Tasks).await;
    assert!(resources.stopping.is_cancelled());
    assert_eq!(runtime.slots.available_permits(), MAX_CONNECTIONS);
}

#[tokio::test]
async fn shutdown_stops_admission_and_drains_owned_tasks() {
    let shutdown = CancellationToken::new();
    let runtime = Lifecycle::new(shutdown.clone());
    let resources = runtime.admit().unwrap();
    let (_, io) = SocketIo::builder().build_layer();
    assert!(resources.bind(io));
    assert!(resources.attach(Lane::Debugger));
    let finished = Arc::new(AtomicBool::new(false));
    let observed = finished.clone();
    let stopped = resources.stopping.clone();
    resources.spawn(async move {
        stopped.cancelled().await;
        observed.store(true, Ordering::Release);
    });
    shutdown.cancel();
    runtime.close().await;
    assert!(finished.load(Ordering::Acquire));
    assert!(resources.stopping.is_cancelled());
    assert!(resources.outbox.reserve_debugger().is_none());
    assert!(runtime.admit().is_none());
    assert_eq!(runtime.slots.available_permits(), MAX_CONNECTIONS);
}

#[tokio::test]
async fn application_shutdown_waits_for_realtime_cleanup_instead_of_detaching_it() {
    let store = Arc::new(apk_infrastructure::store::SqliteStore::open(":memory:").unwrap());
    let app = apk_application::Application::new(store, vec![], 1, 4).unwrap();
    let runtime = Lifecycle::new(app.subscribe_shutdown());
    let resources = runtime.admit().unwrap();
    let (_, io) = SocketIo::builder().build_layer();
    assert!(resources.bind(io));
    assert!(resources.attach(Lane::Tasks));
    let finished = Arc::new(AtomicBool::new(false));
    let observed = finished.clone();
    let stopping = resources.stopping.clone();
    resources.spawn(async move {
        stopping.cancelled().await;
        tokio::task::yield_now().await;
        observed.store(true, Ordering::Release);
    });
    runtime.start(&app);
    app.shutdown().await.unwrap();
    assert!(finished.load(Ordering::Acquire));
    assert!(runtime.admit().is_none());
    assert_eq!(runtime.slots.available_permits(), MAX_CONNECTIONS);
}

#[tokio::test]
async fn unregistered_transport_keeps_quota_until_its_request_owner_is_released() {
    let runtime = Lifecycle::new(CancellationToken::new());
    let resources = runtime.admit().unwrap();
    let transport = resources.track_transport();
    let (_, io) = SocketIo::builder().build_layer();
    assert!(resources.bind(io));
    let closing_resources = resources.clone();
    let closing = tokio::spawn(async move {
        closing_resources.close().await;
    });
    resources.stopping.cancelled().await;
    assert!(!closing.is_finished());
    assert_eq!(runtime.slots.available_permits(), MAX_CONNECTIONS - 1);
    drop(transport);
    closing.await.unwrap();
    assert_eq!(runtime.slots.available_permits(), MAX_CONNECTIONS);
}

fn bridge_fixture(
    plugins: Vec<BridgePlugin>,
) -> (DebuggerService, BridgeLease, BridgeOpened, DebugSession) {
    let service = DebuggerService::new();
    let (lease, opened) = service
        .realtime_open(
            "connection-1",
            BridgeOpen {
                plugins,
                ..Default::default()
            },
        )
        .unwrap();
    let session = service
        .open_session(SessionRequest {
            target: opened.status.targets[0].clone(),
        })
        .unwrap();
    (service, lease, opened, session)
}

fn plugin() -> BridgePlugin {
    BridgePlugin {
        plugin_id: "test.plugin".into(),
        generation: Some("g1".into()),
        version: None,
    }
}

#[test]
fn stale_ready_credit_and_interleaved_receipts_never_exceed_four_delivered() {
    let (service, lease, _, session) = bridge_fixture(vec![plugin()]);
    let commands: Vec<_> = (0..8)
        .map(|_| {
            service
                .enqueue(DebugCommandRequest {
                    session_id: session.session_id.clone(),
                    tool: DebugTool::Inspect,
                    parameters: json!({}),
                })
                .unwrap()
        })
        .collect();
    let first = service.realtime_batch(&lease, 4).unwrap().0;
    assert_eq!(first.commands.len(), 4);
    // 前端尚未收到本批消息时连续报告旧 limit=4，也不得额外领取命令。
    for _ in 0..3 {
        assert!(
            service
                .realtime_batch(&lease, 4)
                .unwrap()
                .0
                .commands
                .is_empty()
        );
    }
    for delivered in &first.commands {
        service
            .realtime_acknowledge(
                &lease,
                BridgeAck {
                    instance_id: lease.instance_id.clone(),
                    command_id: delivered.command_id.clone(),
                    plugin_id: "test.plugin".into(),
                    generation: Some("g1".into()),
                    success: true,
                    response: json!({"ok":true}),
                },
            )
            .unwrap();
        assert_eq!(
            service.realtime_batch(&lease, 4).unwrap().0.commands.len(),
            1
        );
        assert!(
            service
                .realtime_batch(&lease, 4)
                .unwrap()
                .0
                .commands
                .is_empty()
        );
        let current = commands
            .iter()
            .filter(|command| {
                service.command_result(&command.command_id).unwrap().state
                    == CommandState::Delivered
            })
            .count();
        assert_eq!(current, 4);
    }
}

#[test]
fn generation_changed_resume_returns_latest_terminal_summary_without_replay() {
    let (service, old, opened, session) = bridge_fixture(vec![plugin()]);
    let command = service
        .enqueue(DebugCommandRequest {
            session_id: session.session_id,
            tool: DebugTool::Inspect,
            parameters: json!({}),
        })
        .unwrap();
    assert_eq!(service.realtime_batch(&old, 4).unwrap().0.commands.len(), 1);
    let mut replacement = plugin();
    replacement.generation = Some("g2".into());
    let (new, resumed) = service
        .realtime_open(
            "connection-2",
            BridgeOpen {
                instance_id: Some(opened.instance_id),
                resume_key: Some(opened.resume_key),
                plugins: vec![replacement],
                inflight: vec![command.command_id.clone()],
            },
        )
        .unwrap();
    assert_eq!(
        resumed.commands[0].state,
        CommandState::CancelledUnconfirmed
    );
    assert!(resumed.commands[0].response.is_none());
    assert_eq!(
        service.command_result(&command.command_id).unwrap().state,
        CommandState::CancelledUnconfirmed
    );
    assert!(
        service
            .realtime_batch(&new, 4)
            .unwrap()
            .0
            .commands
            .is_empty()
    );
    assert!(service.realtime_batch(&old, 4).is_err());
}

fn near_limit_automation() -> serde_json::Value {
    let steps: Vec<_> = (0..16).map(|index| json!({
        "id":format!("step-{index}"), "tool":"invoke", "parameters":{
            "kind":"command", "id":"test.payload", "input":{"text":"a".repeat(64 * 1024 - 512)},
            "confirmed":true, "allow_unknown_side_effects":true
        }
    })).collect();
    json!({"confirmed":true,"steps":steps})
}

fn full_catalog() -> Vec<BridgePlugin> {
    (0..64)
        .map(|index| BridgePlugin {
            plugin_id: format!("p{index:02}{}", "p".repeat(125)),
            generation: Some("g".repeat(128)),
            version: Some("v".repeat(128)),
        })
        .collect()
}

#[test]
fn near_limit_single_command_with_full_catalog_is_rejected_before_admission() {
    let parameters = near_limit_automation();
    // 先证明参数本身合法，拒绝原因必须是加上完整目录后的实时帧预算。
    validate_debug_command(DebugTool::AutomationRun, &parameters).unwrap();
    assert!(serde_json::to_vec(&parameters).unwrap().len() < 1024 * 1024);
    let (service, lease, _, session) = bridge_fixture(full_catalog());
    let failure = service
        .enqueue(DebugCommandRequest {
            session_id: session.session_id,
            tool: DebugTool::AutomationRun,
            parameters,
        })
        .unwrap_err();
    assert_eq!(failure.code, ErrorCode::Capacity);
    assert!(failure.message.contains("未入队"));
    for _ in 0..2 {
        assert!(
            service
                .realtime_batch(&lease, 4)
                .unwrap()
                .0
                .commands
                .is_empty()
        );
    }
}

#[test]
fn catalog_growth_after_admission_fails_command_without_delivery_or_disconnect() {
    let catalog = full_catalog();
    let (service, lease, _, session) = bridge_fixture(vec![catalog[0].clone()]);
    let command = service
        .enqueue(DebugCommandRequest {
            session_id: session.session_id.clone(),
            tool: DebugTool::AutomationRun,
            parameters: near_limit_automation(),
        })
        .unwrap();
    service
        .realtime_directory(
            &lease,
            BridgeDirectory {
                instance_id: lease.instance_id.clone(),
                plugins: catalog,
            },
        )
        .unwrap();
    assert!(
        service
            .realtime_batch(&lease, 4)
            .unwrap()
            .0
            .commands
            .is_empty()
    );
    let result = service.command_result(&command.command_id).unwrap();
    assert_eq!(result.state, CommandState::Failed);
    assert_eq!(
        result.response.unwrap()["error"]["code"],
        "debugger_capacity"
    );
    // 该连接与会话继续受理新的独立小命令；失败的大命令不得重复出现。
    let next = service
        .enqueue(DebugCommandRequest {
            session_id: session.session_id,
            tool: DebugTool::Inspect,
            parameters: json!({}),
        })
        .unwrap();
    let batch = service.realtime_batch(&lease, 4).unwrap().0;
    assert_eq!(batch.commands.len(), 1);
    assert_eq!(batch.commands[0].command_id, next.command_id);
}
