use super::*;
use crate::Operation;
use serde_json::{Value, json};

#[test]
fn legacy_operation_omits_an_absent_or_null_budget() {
    let legacy = json!({"id":"ordinary.echo","title":"回显","input_schema":{}});
    for execution in [None, Some(Value::Null)] {
        let mut value = legacy.clone();
        if let Some(execution) = execution {
            value["execution"] = execution;
        }
        let operation: Operation = serde_json::from_value(value).unwrap();
        assert!(operation.execution.is_none());
        assert_eq!(serde_json::to_value(operation).unwrap(), legacy);
    }
}

#[test]
fn directory_budget_preserves_explicit_and_default_sources() {
    for source in ["default", "declared"] {
        for total_timeout_ms in [1, DEFAULT_TOTAL_TIMEOUT_MS, MAX_TOTAL_TIMEOUT_MS] {
            let value =
                json!({"api_version":1,"total_timeout_ms":total_timeout_ms,"source":source});
            let execution: OperationExecution = serde_json::from_value(value.clone()).unwrap();
            execution.validate().unwrap();
            assert_eq!(serde_json::to_value(execution).unwrap(), value);
        }
    }
}

#[test]
fn invalid_directory_metadata_is_not_silently_repaired() {
    let valid = json!({"api_version":1,"total_timeout_ms":60_000,"source":"default"});
    for (field, values) in [
        (
            "api_version",
            vec![json!(0), json!(2), json!("1"), Value::Null],
        ),
        (
            "total_timeout_ms",
            vec![
                json!(0),
                json!(3_600_001_u64),
                json!(-1),
                json!(1.5),
                json!("60000"),
            ],
        ),
        ("source", vec![json!("unknown"), json!(1), Value::Null]),
    ] {
        for value in values {
            let mut invalid = valid.clone();
            invalid[field] = value;
            assert!(serde_json::from_value::<OperationExecution>(invalid).is_err());
        }
    }
    let mut extra = valid.clone();
    extra["deadline"] = json!(1);
    assert!(serde_json::from_value::<OperationExecution>(extra).is_err());
    for field in ["api_version", "total_timeout_ms", "source"] {
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<OperationExecution>(missing).is_err());
    }
}

#[test]
fn programmatic_invalid_metadata_reports_invalid_input() {
    for execution in [
        OperationExecution {
            api_version: 2,
            total_timeout_ms: 1,
            source: OperationExecutionSource::Declared,
        },
        OperationExecution {
            api_version: 1,
            total_timeout_ms: 0,
            source: OperationExecutionSource::Default,
        },
        OperationExecution {
            api_version: 1,
            total_timeout_ms: u64::MAX,
            source: OperationExecutionSource::Declared,
        },
    ] {
        assert_eq!(execution.validate().unwrap_err().code(), "invalid_input");
    }
}
