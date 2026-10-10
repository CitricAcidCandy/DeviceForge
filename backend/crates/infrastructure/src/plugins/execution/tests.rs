use super::*;
use crate::plugins::ProcessPlugin;
use apk_domain::Executor;
use apk_plugin_sdk::ExecutionBudget;
use serde_json::json;

fn manifest(protocol: u32) -> Manifest {
    serde_json::from_value(json!({
        "id":"budget_demo","version":"1","protocol_version":protocol,
        "executable":std::env::current_exe().unwrap(),
        "operations":[{"name":"ordinary","title":"普通操作","input_schema":{"type":"object"}}]
    }))
    .unwrap()
}

#[test]
fn process_plugin_maps_only_explicit_declared_budgets_for_every_protocol() {
    for protocol in [1, 2, 3] {
        let legacy = ProcessPlugin::new(manifest(protocol)).unwrap();
        assert!(legacy.operations()[0].execution.is_none());
        for total_timeout_ms in [1, 120_000, 3_600_000] {
            let mut declared = manifest(protocol);
            declared.operations[0].execution = Some(ExecutionBudget {
                api_version: 1,
                total_timeout_ms,
            });
            let plugin = ProcessPlugin::new(declared).unwrap();
            let execution = plugin.operations()[0].execution.unwrap();
            assert_eq!(execution.total_timeout_ms, total_timeout_ms);
            assert_eq!(execution.source, OperationExecutionSource::Declared);
            execution.validate().unwrap();
        }
    }
}

#[test]
fn programmatic_invalid_budget_is_rejected_before_publication() {
    for budget in [
        ExecutionBudget {
            api_version: 2,
            total_timeout_ms: 120_000,
        },
        ExecutionBudget {
            api_version: 1,
            total_timeout_ms: 0,
        },
        ExecutionBudget {
            api_version: 1,
            total_timeout_ms: 3_600_001,
        },
    ] {
        let mut value = manifest(2);
        value.operations[0].execution = Some(budget);
        assert!(matches!(ProcessPlugin::new(value), Err(Error::Invalid(_))));
    }
}

fn device_manifest(protocol: u32) -> Manifest {
    let mut value = serde_json::to_value(manifest(protocol)).unwrap();
    value["operations"] = json!([
        {"name":"discover","title":"发现","input_schema":{"type":"object"}},
        {"name":"describe","title":"描述","input_schema":{"type":"object","required":["device_id","input"],
            "additionalProperties":false,"properties":{"device_id":{"type":"string"},"input":{"type":"object"}}}},
        {"name":"ordinary","title":"普通操作","input_schema":{"type":"object"}}
    ]);
    value["devices"] = json!({"api_version":3,"platform":"synthetic_demo","discover_operation":"discover",
        "capabilities":[{"id":"describe","version":1,"operation":"describe","scope":"device","access":"read"}]});
    serde_json::from_value(value).unwrap()
}

#[test]
fn special_device_operations_reject_repeated_budget_but_other_operations_remain_ordinary() {
    for protocol in [1, 2, 3] {
        for index in [0, 1] {
            let mut value = device_manifest(protocol);
            value.operations[index].execution = Some(ExecutionBudget {
                api_version: 1,
                total_timeout_ms: 120_000,
            });
            assert!(matches!(ProcessPlugin::new(value), Err(Error::Invalid(_))));
        }
        let mut value = device_manifest(protocol);
        value.operations[2].execution = Some(ExecutionBudget {
            api_version: 1,
            total_timeout_ms: 120_000,
        });
        let plugin = ProcessPlugin::new(value).unwrap();
        let operations = plugin.operations();
        assert!(operations[0].execution.is_none());
        assert!(operations[1].execution.is_none());
        assert_eq!(
            operations[2].execution.unwrap().source,
            OperationExecutionSource::Declared
        );
    }
}

#[test]
fn performance_sample_cannot_repeat_budget_and_unrelated_operation_is_not_special() {
    let mut value = serde_json::to_value(manifest(2)).unwrap();
    value["performance"] = json!({"sample_operation":"ordinary"});
    value["operations"][0]["execution"] = json!({"api_version":1,"total_timeout_ms":60_000});
    assert!(matches!(
        ProcessPlugin::new(serde_json::from_value(value.clone()).unwrap()),
        Err(Error::Invalid(_))
    ));
    value["operations"][0]
        .as_object_mut()
        .unwrap()
        .remove("execution");
    value["operations"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":"build","title":"构建","input_schema":{},
        "execution":{"api_version":1,"total_timeout_ms":120_000}}));
    let plugin = ProcessPlugin::new(serde_json::from_value(value).unwrap()).unwrap();
    assert!(plugin.operations()[0].execution.is_none());
    assert_eq!(
        plugin.operations()[1].execution.unwrap().total_timeout_ms,
        120_000
    );
}
