//! 活动查询复用现有命令历史；只读观察不能造成派发、续期或跨目标泄漏。
use super::*;

fn activity_query(session: &DebugSession) -> ActivityQuery {
    ActivityQuery {
        session_id: session.session_id.clone(),
        limit: 20,
        before: None,
        command_id: None,
    }
}

#[test]
fn debugger_automation_labels_are_optional_bounded_unicode_display_only() {
    let valid = json!({"steps":[{"id":"read","label":"读取当前配置","tool":"data_read","parameters":{"source_id":"aliases"}}],"confirmed":false});
    assert!(validate_debug_command(DebugTool::AutomationRun, &valid).is_ok());
    let mut input = valid.clone();
    input["steps"][0]["label"] = json!("读".repeat(80));
    assert!(validate_debug_command(DebugTool::AutomationRun, &input).is_ok());
    for value in [
        json!(""),
        json!("  "),
        json!("读".repeat(81)),
        json!("读取\n配置"),
        json!(123),
        json!(null),
    ] {
        input["steps"][0]["label"] = value;
        assert!(validate_debug_command(DebugTool::AutomationRun, &input).is_err());
    }
    input = valid;
    input["steps"][0].as_object_mut().unwrap().remove("label");
    assert!(validate_debug_command(DebugTool::AutomationRun, &input).is_ok());
}

#[tokio::test(start_paused = true)]
async fn debugger_activity_observes_other_session_without_parameters_or_session_identity() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let agent = open(&service, &instance);
    let observer = open(&service, &instance);
    let mut input = request(&agent);
    input.tool = DebugTool::AutomationRun;
    input.parameters = json!({"steps":[{"id":"read","label":"读取配置","tool":"data_read","parameters":{"source_id":"aliases","query":{"business_value":"不公开"}}}],"confirmed":false});
    let command = service.enqueue(input).unwrap();
    let page = service.activity(activity_query(&observer)).unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].state, CommandState::Queued);
    assert_eq!(page.items[0].steps[0].label.as_deref(), Some("读取配置"));
    assert_eq!(page.items[0].response, None);
    let encoded = serde_json::to_string(&page).unwrap();
    assert!(!encoded.contains("business_value") && !encoded.contains(&agent.session_id));
    let polled = service.poll(poll(&instance)).await.unwrap();
    assert_eq!(polled.commands[0].command_id, command.command_id);
    assert!(polled.commands[0].parameters["steps"][0]["label"] == "读取配置");
    let mut response = ack(&instance, &command.command_id);
    response.response = json!({"status":"completed","steps":[{"id":"read","tool":"data_read","label":"读取配置","status":"succeeded","result":{"value":{"name":"示例"}}}]});
    service.acknowledge(response.clone()).unwrap();
    service.close_session(&agent.session_id).unwrap();
    service.close_session(&observer.session_id).unwrap();
    let mut query = activity_query(&observer);
    assert!(
        service.activity(query.clone()).unwrap().items[0]
            .response
            .is_none()
    );
    query.command_id = Some(command.command_id.clone());
    let detail = service.activity(query.clone()).unwrap();
    assert_eq!(detail.items[0].response, Some(response.response));
    assert_eq!(detail.items[0].steps[0].label.as_deref(), Some("读取配置"));
    assert_eq!(
        serde_json::to_value(service.activity(query).unwrap()).unwrap(),
        serde_json::to_value(detail).unwrap()
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
async fn debugger_activity_exact_target_isolation_and_closed_history() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let other_instance = register(&service);
    let current = open(&service, &instance);
    let other = open(&service, &other_instance);
    let command = service.enqueue(request(&current)).unwrap();
    assert!(
        service
            .activity(activity_query(&other))
            .unwrap()
            .items
            .is_empty()
    );
    let mut detail = activity_query(&other);
    detail.command_id = Some(command.command_id.clone());
    assert_eq!(
        service.activity(detail).unwrap_err().code,
        ErrorCode::NotFound
    );
    service
        .heartbeat(BridgeHeartbeat {
            instance_id: instance.instance_id.clone(),
            plugins: Some(vec![plugin("g2")]),
        })
        .unwrap();
    let mut next_target = target(&instance);
    next_target.generation = Some("g2".into());
    let next = service
        .open_session(SessionRequest {
            target: next_target,
        })
        .unwrap();
    assert!(
        service
            .activity(activity_query(&next))
            .unwrap()
            .items
            .is_empty()
    );
    let historical = service.activity(activity_query(&current)).unwrap();
    assert_eq!(
        historical.items[0].state,
        CommandState::CancelledUnconfirmed
    );
    assert_eq!(historical.target.generation.as_deref(), Some("g1"));
    let unknown = ActivityQuery {
        session_id: "missing".into(),
        ..activity_query(&current)
    };
    assert_eq!(
        service.activity(unknown).unwrap_err().code,
        ErrorCode::NotFound
    );
}

#[tokio::test(start_paused = true)]
async fn debugger_activity_pagination_is_stable_and_eviction_has_gap() {
    let service = DebuggerService::with_config(DebuggerConfig {
        max_command_history: 2,
        ..DebuggerConfig::default()
    })
    .unwrap();
    let instance = register(&service);
    let session = open(&service, &instance);
    for _ in 0..3 {
        let command = service.enqueue(request(&session)).unwrap();
        service.poll(poll(&instance)).await.unwrap();
        service
            .acknowledge(ack(&instance, &command.command_id))
            .unwrap();
    }
    let mut query = activity_query(&session);
    query.limit = 1;
    let first = service.activity(query.clone()).unwrap();
    assert!(first.gap && first.retained_only);
    assert_eq!(first.items.len(), 1);
    query.before = first.next_before;
    let second = service.activity(query.clone()).unwrap();
    assert!(second.items[0].sequence < first.items[0].sequence);
    assert_eq!(second.next_before, None);
    query.limit = 0;
    assert!(service.activity(query.clone()).is_err());
    query.limit = 51;
    assert!(service.activity(query.clone()).is_err());
    query.limit = 1;
    query.before = Some(0);
    assert!(service.activity(query).is_err());
}

#[tokio::test(start_paused = true)]
async fn debugger_activity_does_not_renew_observer_session_or_admit_new_work() {
    let service = DebuggerService::with_config(DebuggerConfig {
        session_ttl: Duration::from_millis(100),
        ..DebuggerConfig::default()
    })
    .unwrap();
    let instance = register(&service);
    let observer = open(&service, &instance);
    tokio::time::advance(Duration::from_millis(80)).await;
    assert!(service.activity(activity_query(&observer)).is_ok());
    tokio::time::advance(Duration::from_millis(25)).await;
    assert_eq!(
        service.session(&observer.session_id).unwrap().state,
        SessionState::Expired
    );
    assert!(service.activity(activity_query(&observer)).is_ok());
    assert_eq!(
        service.enqueue(request(&observer)).unwrap_err().code,
        ErrorCode::InactiveSession
    );
}
