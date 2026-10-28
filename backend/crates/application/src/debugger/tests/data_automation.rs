//! 只验证本批协议准入、预算与一次投递，不执行插件业务或浏览器。
use super::*;

fn data_write() -> serde_json::Value {
    json!({"source_id":"aliases","expected_revision":"r1","value":{"alias":"新名称"},"confirmed":true})
}

fn run(steps: serde_json::Value) -> serde_json::Value {
    json!({"steps":steps,"confirmed":true})
}

#[test]
fn debugger_data_inputs_require_explicit_source_revision_confirmation_and_projection() {
    assert!(validate_debug_command(DebugTool::DataCatalog, &json!({})).is_ok());
    assert!(validate_debug_command(DebugTool::DataCatalog, &json!({"query":1})).is_err());
    assert!(
        validate_debug_command(
            DebugTool::DataRead,
            &json!({"source_id":"aliases","query":{"limit":10}})
        )
        .is_ok()
    );
    for value in [
        json!({}),
        json!({"source_id":" "}),
        json!({"source_id":"aliases","path":"private"}),
    ] {
        assert!(validate_debug_command(DebugTool::DataRead, &value).is_err());
    }
    assert!(validate_debug_command(DebugTool::DataWrite, &data_write()).is_ok());
    for field in ["source_id", "expected_revision", "value", "confirmed"] {
        let mut input = data_write();
        input.as_object_mut().unwrap().remove(field);
        assert!(
            validate_debug_command(DebugTool::DataWrite, &input).is_err(),
            "{field}"
        );
    }
    let mut input = data_write();
    input["confirmed"] = json!(false);
    assert!(validate_debug_command(DebugTool::DataWrite, &input).is_err());
    input["confirmed"] = json!(true);
    input["value"] = json!({"api_key":"禁止原文"});
    assert!(validate_debug_command(DebugTool::DataWrite, &input).is_err());
}

#[test]
fn debugger_data_value_256k_budget_does_not_expand_ordinary_commands() {
    let mut input = data_write();
    input["value"] = json!("x".repeat(256 * 1024 - 2));
    assert!(validate_debug_command(DebugTool::DataWrite, &input).is_ok());
    input["value"] = json!("x".repeat(256 * 1024 - 1));
    assert_eq!(
        validate_debug_command(DebugTool::DataWrite, &input)
            .unwrap_err()
            .code,
        ErrorCode::Capacity
    );
    assert_eq!(
        validate_debug_command(DebugTool::Inspect, &json!({"value":"x".repeat(64 * 1024)}))
            .unwrap_err()
            .code,
        ErrorCode::Capacity
    );
}

#[test]
fn debugger_automation_requires_bounded_unique_whitelisted_steps_and_write_confirmation() {
    let read = json!({"id":"read","tool":"data_read","parameters":{"source_id":"aliases"}});
    assert!(validate_debug_command(DebugTool::AutomationRun, &run(json!([read.clone()]))).is_ok());
    for steps in [
        json!([]),
        json!([read.clone(), read]),
        json!(vec![
            json!({"id":"step","tool":"inspect","parameters":{}});
            33
        ]),
        json!([{"id":"nested","tool":"automation_run","parameters":{}}]),
        json!([{"id":"reload","tool":"reload","parameters":{}}]),
        json!([{"id":"unknown","tool":"eval","parameters":{}}]),
        json!([{"id":"extra","tool":"inspect","parameters":{},"expect":{}}]),
    ] {
        assert!(validate_debug_command(DebugTool::AutomationRun, &run(steps)).is_err());
    }
    let mut input = run(json!([{"id":"write","tool":"data_write","parameters":data_write()}]));
    input["confirmed"] = json!(false);
    assert!(validate_debug_command(DebugTool::AutomationRun, &input).is_err());
    input = json!({"steps":[{"id":"inspect","tool":"inspect","parameters":{}}],"confirmed":false});
    assert!(validate_debug_command(DebugTool::AutomationRun, &input).is_ok());
}

#[test]
fn debugger_automation_bindings_only_use_prior_query_or_same_source_read() {
    let valid = run(json!([
        {"id":"query","tool":"ui_query","parameters":{}},
        {"id":"click","tool":"ui_action","parameters":{"action":{"type":"click","confirmed":true}},"bind":{"target_from_step":"query"}},
        {"id":"read","tool":"data_read","parameters":{"source_id":"aliases"}},
        {"id":"write","tool":"data_write","parameters":{"source_id":"aliases","value":{"alias":"新名称"},"confirmed":true},"bind":{"revision_from_step":"read"}}
    ]));
    assert!(validate_debug_command(DebugTool::AutomationRun, &valid).is_ok());
    for (index, field, value) in [
        (1, "target_from_step", "write"),
        (1, "target_from_step", "missing"),
        (1, "target_from_step", "read"),
        (3, "revision_from_step", "query"),
    ] {
        let mut input = valid.clone();
        input["steps"][index]["bind"][field] = json!(value);
        assert!(validate_debug_command(DebugTool::AutomationRun, &input).is_err());
    }
    let mut input = valid.clone();
    input["steps"][3]["parameters"]["source_id"] = json!("other");
    assert!(validate_debug_command(DebugTool::AutomationRun, &input).is_err());
    input = valid.clone();
    input["steps"][3]["parameters"]["expected_revision"] = json!("static");
    assert!(validate_debug_command(DebugTool::AutomationRun, &input).is_err());
    input = valid;
    input["steps"][1]["parameters"]["action"]["target"] = json!({"id":"static"});
    assert!(validate_debug_command(DebugTool::AutomationRun, &input).is_err());
}

#[tokio::test(start_paused = true)]
async fn debugger_automation_single_delivery_has_30s_budget_and_never_replays_unknown_results() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let session = open(&service, &instance);
    let mut input = request(&session);
    input.tool = DebugTool::AutomationRun;
    input.parameters = run(json!([{"id":"inspect","tool":"inspect","parameters":{}}]));
    let receipt = service.enqueue(input).unwrap();
    assert_eq!(receipt.timeout_ms, 30_000);
    let delivered = service.poll(poll(&instance)).await.unwrap();
    assert_eq!(delivered.commands.len(), 1);
    assert_eq!(delivered.commands[0].tool, DebugTool::AutomationRun);
    assert!(
        service
            .poll(poll(&instance))
            .await
            .unwrap()
            .commands
            .is_empty()
    );
    tokio::time::advance(Duration::from_secs(29)).await;
    assert_eq!(
        service.command_result(&receipt.command_id).unwrap().state,
        CommandState::TimedOutUnconfirmed
    );
    assert_eq!(
        service
            .acknowledge(ack(&instance, &receipt.command_id))
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
}

#[tokio::test(start_paused = true)]
async fn debugger_data_cas_failure_preserves_original_receipt_and_old_generation_is_rejected() {
    let service = DebuggerService::new();
    let instance = register(&service);
    let session = open(&service, &instance);
    let mut input = request(&session);
    input.tool = DebugTool::DataWrite;
    input.parameters = data_write();
    let receipt = service.enqueue(input).unwrap();
    assert_eq!(receipt.timeout_ms, 10_000);
    service.poll(poll(&instance)).await.unwrap();
    let mut response = ack(&instance, &receipt.command_id);
    response.success = false;
    response.response = json!({"code":"revision_conflict","message":"数据已修改，请重新读取"});
    service.acknowledge(response.clone()).unwrap();
    let result = service.command_result(&receipt.command_id).unwrap();
    assert_eq!(result.state, CommandState::Failed);
    assert_eq!(result.response, Some(response.response));
    assert!(
        service
            .poll(poll(&instance))
            .await
            .unwrap()
            .commands
            .is_empty()
    );
    service
        .heartbeat(BridgeHeartbeat {
            instance_id: instance.instance_id.clone(),
            plugins: Some(vec![plugin("g2")]),
        })
        .unwrap();
    let mut stale = request(&session);
    stale.tool = DebugTool::DataRead;
    stale.parameters = json!({"source_id":"aliases"});
    assert_eq!(
        service.enqueue(stale).unwrap_err().code,
        ErrorCode::InactiveSession
    );
}

#[test]
fn debugger_automation_schema_exposes_limit_whitelist_and_dynamic_bindings() {
    let schema = serde_json::to_value(schemars::schema_for!(AutomationInput)).unwrap();
    assert_eq!(schema["properties"]["steps"]["minItems"], 1);
    assert_eq!(schema["properties"]["steps"]["maxItems"], 32);
    let text = serde_json::to_string(&schema).unwrap();
    assert!(text.contains("target_from_step") && text.contains("revision_from_step"));
    assert!(!text.contains("automation_run") && !text.contains("reload"));
}

#[test]
fn debugger_data_business_nodes_skip_ui_count_without_bypassing_secret_or_size_limits() {
    let value = json!({"source_id":"aliases","revision":"r1","value":{"nodes":vec![json!({"alias":"业务行"});600]}});
    assert!(validation::response_for(DebugTool::DataRead, &value).is_ok());
    assert!(validation::response(&value).is_err());
    let run =
        json!({"status":"succeeded","steps":[{"id":"read","tool":"data_read","result":value}]});
    assert!(validation::response_for(DebugTool::AutomationRun, &run).is_ok());
    let ui = json!({"steps":[{"id":"query","tool":"ui_query","result":{"value":{"nodes":vec![json!({});501]}}}]});
    assert!(validation::response_for(DebugTool::AutomationRun, &ui).is_err());
    let secret = json!({"value":{"password":"不可原文返回"}});
    assert!(validation::response_for(DebugTool::DataRead, &secret).is_err());
    let large = json!({"value":"x".repeat(256*1024)});
    assert!(validation::response_for(DebugTool::DataRead, &large).is_err());
}

#[test]
fn debugger_automation_response_keeps_ui_budget_per_step_and_global_structure_limit() {
    let step =
        json!({"id":"query","tool":"ui_query","result":{"nodes":vec![json!({"id":"node"});100]}});
    let mut response = json!({"steps":vec![step;32]});
    assert!(validation::response_for(DebugTool::AutomationRun, &response).is_ok());
    response["steps"][0]["result"]["nodes"] = json!(vec![json!({"id":"node"}); 501]);
    assert!(validation::response_for(DebugTool::AutomationRun, &response).is_err());
    response = json!({"steps":vec![json!({"id":"step","tool":"inspect","result":{}});33]});
    assert!(validation::response_for(DebugTool::AutomationRun, &response).is_err());
}
