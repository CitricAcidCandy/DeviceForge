use super::*;
use serde_json::json;

fn access(fields: &[&str], pointers: &[&str]) -> ArtifactAccess {
    ArtifactAccess {
        input_fields: fields.iter().map(|value| (*value).into()).collect(),
        input_pointers: pointers.iter().map(|value| (*value).into()).collect(),
        outputs: false,
    }
}

#[test]
fn declarations_reject_ambiguous_paths_and_bound_combined_selectors() {
    for declaration in [
        access(&["source"], &["/source"]),
        access(&["source", "source"], &[]),
        access(&[], &["/input/source", "/input/source"]),
        access(&["input.source"], &[]),
        access(&[""], &[]),
        access(&["a", "b", "c", "d"], &["/e", "/f", "/g", "/h", "/i"]),
    ] {
        assert!(matches!(validate(&declaration), Err(Error::Invalid(_))));
    }
    assert!(validate(&access(&["a", "b", "c", "d"], &["/e", "/f", "/g", "/h"])).is_ok());
}

#[test]
fn pointers_require_valid_escapes_and_utf8_byte_depth_limits() {
    for pointer in [
        "",
        "input/source",
        "#/input/source",
        "/a~",
        "/a~2",
        "/a/~x",
        "/a/b/c/d/e/f/g/h/i",
    ] {
        assert!(validate(&access(&[], &[pointer])).is_err(), "{pointer}");
    }
    let max = format!("/{}", "x".repeat(255));
    assert!(validate(&access(&[], &[&max])).is_ok());
    assert!(validate(&access(&[], &[&format!("{max}x")])).is_err());
    assert!(validate(&access(&[], &[&format!("/{}", "中".repeat(86))])).is_err());
    assert!(
        validate(&access(
            &[],
            &["/a/b/c/d/e/f/g/h", "/a~0b~1c", "/输入/产物", "/"]
        ))
        .is_ok()
    );
}

#[test]
fn escaped_object_keys_and_array_positions_keep_exact_context_labels() {
    let declaration = access(
        &["top"],
        &["/input/a~1b", "/input/~01", "/input/列表/0", "/"],
    );
    let input = json!({"top":"top-id","input":{"a/b":["first","second"],"~1":"escaped","列表":["indexed"]},"":"empty-key","hidden":"unselected"});
    let original = input.clone();
    let selected = select(&declaration, &input).unwrap();
    assert_eq!(
        selected
            .iter()
            .map(|item| (item.field, item.artifact_id))
            .collect::<Vec<_>>(),
        [
            ("top", "top-id"),
            ("/input/a~1b", "first"),
            ("/input/a~1b", "second"),
            ("/input/~01", "escaped"),
            ("/input/列表/0", "indexed"),
            ("/", "empty-key")
        ]
    );
    assert_eq!(input, original);
}

#[test]
fn absent_keys_and_out_of_range_arrays_are_optional_without_fallback_search() {
    let declaration = access(
        &["missing"],
        &[
            "/missing/id",
            "/input/4",
            "/input/0/id",
            "/input/999999999999999999999999999999999",
        ],
    );
    let input = json!({"input":[{}],"id":"must-not-be-selected"});
    assert!(select(&declaration, &input).unwrap().is_empty());
    assert!(
        select(&access(&[], &["/input/ids"]), &json!({"input":{"ids":[]}}))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn wrong_container_and_array_index_are_errors_instead_of_missing_inputs() {
    let declaration = access(&[], &["/input/id"]);
    for input in [
        json!({"input":null}),
        json!({"input":"id"}),
        json!({"input":4}),
        json!({"input":true}),
    ] {
        assert!(matches!(
            select(&declaration, &input),
            Err(Error::Invalid(_))
        ));
    }
    for index in ["01", "-", "-1", "+1", "0x1", "", "a"] {
        assert!(matches!(
            select(
                &access(&[], &[&format!("/input/{index}")]),
                &json!({"input":["id"]})
            ),
            Err(Error::Invalid(_))
        ));
    }
    let selected_input = json!({"input":{"01":"object-key"}});
    let selected_access = access(&[], &["/input/01"]);
    assert_eq!(
        select(&selected_access, &selected_input).unwrap()[0].artifact_id,
        "object-key"
    );
}

#[test]
fn invalid_terminals_and_mixed_arrays_fail_before_returning_any_selection() {
    let declaration = access(&["valid"], &["/input/id"]);
    for value in [
        json!(null),
        json!(42),
        json!(true),
        json!({"id":"x"}),
        json!(["id", 2]),
        json!([["id"]]),
    ] {
        let input = json!({"valid":"valid-id","input":{"id":value}});
        assert!(matches!(
            select(&declaration, &input),
            Err(Error::Invalid(_))
        ));
    }
}

#[test]
fn actual_file_limit_combines_arrays_and_preserves_distinct_reference_labels() {
    let declaration = access(&["top"], &["/input/ids"]);
    let ids = vec!["same"; 7];
    let input = json!({"top":"same","input":{"ids":ids}});
    let selected = select(&declaration, &input).unwrap();
    assert_eq!(selected.len(), 8);
    assert_eq!(selected[0].field, "top");
    assert!(selected[1..].iter().all(|item| item.field == "/input/ids"));
    assert!(matches!(
        select(
            &declaration,
            &json!({"top":"same","input":{"ids":vec!["same";8]}})
        ),
        Err(Error::Invalid(_))
    ));
}
