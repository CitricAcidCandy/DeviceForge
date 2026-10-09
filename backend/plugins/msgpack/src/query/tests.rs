use super::*;

fn run(records: Value, input: Value) -> Result<Value, String> {
    let options: Options = serde_json::from_value(input).map_err(|_| "参数无效")?;
    options.validate()?;
    execute(records, options)
}
#[test]
fn filtering_precedes_offset_and_id_lookup_uses_same_contract() {
    let records = json!([{"id":1,"name":"设备甲"},{"id":2,"name":"设备乙"},{"id":3,"name":"设备丙"},{"id":4,"name":"其他"}]);
    let page = run(records.clone(), json!({"artifact_id":"id","offset":1,"limit":1,"filter":{"field":"name","operator":"contains","value":"设备"}})).unwrap();
    assert_eq!(page["total"], 4);
    assert_eq!(page["matched"], 3);
    assert_eq!(page["records"], json!([{"id":2,"name":"设备乙"}]));
    assert_eq!(page["next_offset"], 2);
    let record = run(
        records,
        json!({"artifact_id":"id","limit":1,"filter":{"field":"id","operator":"equals","value":3}}),
    )
    .unwrap();
    assert_eq!(record["records"][0]["id"], 3);
    assert!(record["next_offset"].is_null());
}
#[test]
fn numbers_compare_exactly_and_unsafe_float_mixing_fails() {
    let records = json!([{"n":i64::MIN},{"n":0},{"n":u64::MAX}]);
    for (operator, expected) in [("greater", json!(u64::MAX)), ("less", json!(i64::MIN))] {
        let page = run(
            records.clone(),
            json!({"artifact_id":"id","filter":{"field":"n","operator":operator,"value":0}}),
        )
        .unwrap();
        assert_eq!(page["matched"], 1);
        assert_eq!(page["records"][0]["n"], expected);
    }
    assert!(
        run(
            records,
            json!({"artifact_id":"id","filter":{"field":"n","operator":"equals","value":0.0}})
        )
        .is_err()
    );
    assert_eq!(
        run(
            json!([{"n":1},{"n":1.0},{"n":1.5}]),
            json!({"artifact_id":"id","filter":{"field":"n","operator":"equals","value":1}})
        )
        .unwrap()["matched"],
        2
    );
}
#[test]
fn missing_fields_null_and_pagination_end_are_explicit() {
    let records = json!([{}, {"x":null}, 3]);
    let page = run(records, json!({"artifact_id":"id","offset":1,"filter":{"field":"x","operator":"equals","value":null}})).unwrap();
    assert_eq!(page["matched"], 1);
    assert_eq!(page["records"], json!([]));
    assert!(page["next_offset"].is_null());
    assert!(run(json!([]), json!({"artifact_id":"id","offset":1})).is_err());
    assert!(run(json!({}), json!({"artifact_id":"id"})).is_err());
}
#[test]
fn invalid_parameters_and_large_pages_fail() {
    for extra in [
        json!({"limit":0}),
        json!({"limit":101}),
        json!({"offset":100001}),
        json!({"path":"server"}),
        json!({"filter":{"field":"x","operator":"contains","value":1}}),
        json!({"filter":{"field":"","operator":"equals","value":1}}),
        json!({"filter":{"field":"x","operator":"greater","value":"1"}}),
    ] {
        let mut input = json!({"artifact_id":"id"});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(run(json!([]), input).is_err());
    }
    assert!(
        run(
            json!([{"body":"x".repeat(128 * 1024)}]),
            json!({"artifact_id":"id","limit":1})
        )
        .is_err()
    );
}
