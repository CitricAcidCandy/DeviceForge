use super::*;
use crate::Contribution;
use serde_json::{Value, json};

#[test]
fn omitted_and_null_execution_preserve_legacy_contributions() {
    let legacy = json!({"name":"echo","title":"回显","input_schema":{"type":"object"}});
    for execution in [None, Some(Value::Null)] {
        let mut value = legacy.clone();
        if let Some(execution) = execution {
            value["execution"] = execution;
        }
        let contribution: Contribution = serde_json::from_value(value).unwrap();
        assert!(contribution.execution.is_none());
        assert_eq!(serde_json::to_value(contribution).unwrap(), legacy);
    }
}

#[test]
fn explicit_budget_roundtrips_without_a_host_source_or_deadline() {
    for total_timeout_ms in [1, 60_000, 120_000, 3_600_000] {
        let budget = json!({"api_version":1,"total_timeout_ms":total_timeout_ms});
        let parsed: ExecutionBudget = serde_json::from_value(budget.clone()).unwrap();
        parsed.validate().unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), budget);
        let value = json!({"name":"build","title":"构建","input_schema":{},"execution":budget});
        let contribution: Contribution = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(contribution).unwrap(), value);
    }
}

#[test]
fn malformed_budgets_are_rejected_during_deserialization() {
    for invalid in [
        json!(0),
        json!(-1),
        json!(3_600_001_u64),
        json!(1.5),
        json!("60000"),
        json!(true),
        Value::Null,
        json!([]),
        json!({}),
    ] {
        assert!(
            serde_json::from_value::<ExecutionBudget>(
                json!({"api_version":1,"total_timeout_ms":invalid})
            )
            .is_err()
        );
    }
    for invalid in [
        json!(0),
        json!(2),
        json!(-1),
        json!(1.5),
        json!("1"),
        Value::Null,
    ] {
        assert!(
            serde_json::from_value::<ExecutionBudget>(
                json!({"api_version":invalid,"total_timeout_ms":1})
            )
            .is_err()
        );
    }
    for invalid in [
        json!({}),
        json!({"api_version":1}),
        json!({"total_timeout_ms":1}),
        json!({"api_version":1,"total_timeout_ms":1,"source":"declared"}),
    ] {
        assert!(serde_json::from_value::<ExecutionBudget>(invalid).is_err());
    }
    assert!(
        serde_json::from_str::<ExecutionBudget>(
            r#"{"api_version":1,"total_timeout_ms":1,"total_timeout_ms":2}"#
        )
        .is_err()
    );
}

#[test]
fn programmatic_budgets_require_the_same_valid_range() {
    for budget in [
        ExecutionBudget {
            api_version: 2,
            total_timeout_ms: 1,
        },
        ExecutionBudget {
            api_version: 1,
            total_timeout_ms: 0,
        },
        ExecutionBudget {
            api_version: 1,
            total_timeout_ms: u64::MAX,
        },
    ] {
        assert!(budget.validate().is_err());
    }
}
