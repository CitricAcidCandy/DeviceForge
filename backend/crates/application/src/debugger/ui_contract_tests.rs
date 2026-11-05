//! 公开模式与实际准入同时验证，不观察浏览器、不执行插件或创建文件。

use super::{ui_contract::*, *};
use serde_json::{Value, json};
use std::sync::{
    OnceLock,
    atomic::{AtomicU64, Ordering},
};

#[test]
fn ui_error_hints_are_bounded_without_repeating_union_catalog_or_private_values() {
    for (tool, input) in [
        (
            DebugTool::UiAction,
            json!({"action":{"type":"不得回显的未知动作","value":"不得回显的输入"}}),
        ),
        (
            DebugTool::UiAction,
            json!({"action":{"value":"不得回显的输入"}}),
        ),
        (
            DebugTool::UiTree,
            json!({"view":"不得回显的视图","private":"不得回显的输入"}),
        ),
    ] {
        let failure = validate_debug_command(tool, &input).unwrap_err();
        let details: Value =
            serde_json::from_str(failure.message.split_once("details=").unwrap().1).unwrap();
        assert!(details["expected"].as_str().unwrap().chars().count() < 256);
        assert!(failure.message.len() < 2500);
        assert!(!failure.message.contains("不得回显"));
        if tool == DebugTool::UiAction {
            assert_eq!(details["path"], "parameters.action.type");
        }
    }
}

fn schema<T: schemars::JsonSchema>() -> Value {
    let mut settings = schemars::generate::SchemaSettings::draft2020_12();
    settings.inline_subschemas = true;
    serde_json::to_value(settings.into_generator().into_root_schema_for::<T>()).unwrap()
}

fn published(tool: DebugTool) -> &'static jsonschema::Validator {
    static VALIDATORS: OnceLock<Vec<(DebugTool, jsonschema::Validator)>> = OnceLock::new();
    VALIDATORS
        .get_or_init(|| {
            [
                (DebugTool::UiTree, schema::<UiTreeInput>()),
                (DebugTool::UiQuery, schema::<UiQueryInput>()),
                (DebugTool::UiDiff, schema::<UiDiffInput>()),
                (DebugTool::UiAssert, schema::<UiAssertInput>()),
                (DebugTool::UiAction, schema::<UiActionInput>()),
                (DebugTool::AutomationRun, schema::<AutomationInput>()),
            ]
            .into_iter()
            .map(|(tool, schema)| (tool, jsonschema::validator_for(&schema).unwrap()))
            .collect()
        })
        .iter()
        .find(|(candidate, _)| *candidate == tool)
        .map(|(_, validator)| validator)
        .unwrap()
}

fn valid(tool: DebugTool, parameters: &Value) {
    assert!(
        published(tool).is_valid(parameters),
        "公开模式拒绝 {tool:?}: {parameters}"
    );
    assert_eq!(
        validate_debug_command(tool, parameters),
        Ok(()),
        "实际准入拒绝 {tool:?}"
    );
}

fn invalid(tool: DebugTool, parameters: &Value) -> DebuggerError {
    assert!(
        !published(tool).is_valid(parameters),
        "公开模式误收 {tool:?}: {parameters}"
    );
    let error = validate_debug_command(tool, parameters).expect_err("非法输入必须在派发前拒绝");
    assert_eq!(error.code, ErrorCode::InvalidInput);
    error
}

fn details(error: &DebuggerError) -> Value {
    serde_json::from_str(error.message.split_once("details=").unwrap().1).unwrap()
}

fn node() -> Value {
    json!({"id":"node-1","generation":1,"revision":2})
}

fn action(kind: &str) -> Value {
    match kind {
        "highlight" | "click" | "scroll" => json!({"type":kind,"target":node(),"confirmed":true}),
        "fill" => json!({"type":kind,"target":node(),"value":"设备地址","confirmed":true}),
        "select" => json!({"type":kind,"target":node(),"values":["mirror"],"confirmed":true}),
        "wait" => json!({"type":kind,"assertion":{"condition":"exists","query":{"id":"node-1"}}}),
        "navigate" => json!({"type":kind,"path":"/devices","confirmed":true}),
        "pick" => json!({"type":kind}),
        _ => unreachable!("测试动作必须在公开清单中"),
    }
}

#[test]
fn ui_tree_snapshot_overview_and_pagination_branches_accept_public_inputs() {
    for parameters in [
        json!({}),
        json!({"root_id":"root-1"}),
        json!({"root_id":"root-1","snapshot_id":"snapshot-1","offset":5000,"limit":1}),
        json!({"view":"overview"}),
        json!({"view":"overview","offset":10000,"limit":500}),
    ] {
        valid(DebugTool::UiTree, &parameters);
        assert!(serde_json::from_value::<UiTreeInput>(parameters).is_ok());
    }
    for parameters in [
        json!({"offset":1}),
        json!({"snapshot_id":"snapshot-1","offset":5001}),
        json!({"limit":0}),
        json!({"limit":501}),
        json!({"view":"overview","root_id":"root-1"}),
        json!({"view":"overview","snapshot_id":"snapshot-1"}),
        json!({"view":"overview","offset":10001}),
        json!({"view":"unknown"}),
    ] {
        invalid(DebugTool::UiTree, &parameters);
    }
}

#[test]
fn ui_query_preserves_default_and_camel_case_filters_with_three_evidence_states() {
    valid(DebugTool::UiQuery, &json!({}));
    valid(DebugTool::UiQuery, &json!({"root_id":"root-1","query":{}}));
    for evidence in ["yes", "no", "unknown"] {
        valid(
            DebugTool::UiQuery,
            &json!({"root_id":"root-1","query":{
                "id":"node-1","role":"textbox","name":"设备地址",
                "surfaceId":"surface-1","descendantOf":"node-parent",
                "hidden":evidence,"disabled":evidence,"limit":500
            }}),
        );
    }
    for query in [
        json!({"surface_id":"surface-1"}),
        json!({"descendant_of":"node-parent"}),
        json!({"hidden":true}),
        json!({"disabled":"maybe"}),
        json!({"limit":0}),
        json!({"limit":501}),
        json!({"name":"   "}),
        json!({"id":"a".repeat(257)}),
    ] {
        invalid(DebugTool::UiQuery, &json!({"query":query}));
    }
}

#[test]
fn ui_diff_requires_both_snapshot_ids_and_preserves_optional_root() {
    for parameters in [
        json!({"before_id":"before","after_id":"after"}),
        json!({"root_id":"root-1","before_id":"before","after_id":"after"}),
    ] {
        valid(DebugTool::UiDiff, &parameters);
        assert!(serde_json::from_value::<UiDiffInput>(parameters).is_ok());
    }
    for parameters in [
        json!({"before_id":"before"}),
        json!({"after_id":"after"}),
        json!({"beforeId":"before","afterId":"after"}),
        json!({"before_id":"","after_id":"after"}),
        json!({"before_id":"before","after_id":"after","query":{}}),
    ] {
        invalid(DebugTool::UiDiff, &parameters);
    }
}

#[test]
fn ui_assert_accepts_every_condition_and_rejects_missing_or_unknown_conditions() {
    for condition in [
        "exists",
        "absent",
        "enabled",
        "visible",
        "valid",
        "in_viewport",
        "within_root",
        "unclipped",
        "nonzero_size",
        "count",
        "value_equals",
        "selected_equals",
    ] {
        let mut assertion = json!({"condition":condition,"query":{"id":"node-1"}});
        match condition {
            "count" => assertion["expected"] = json!(0),
            "value_equals" => assertion["expected"] = json!("设备地址"),
            "selected_equals" => assertion["expected"] = json!(["mirror"]),
            _ => {}
        }
        for root in [false, true] {
            let mut parameters = json!({"assertion":assertion});
            if root {
                parameters["root_id"] = json!("root-1");
            }
            valid(DebugTool::UiAssert, &parameters);
            assert!(serde_json::from_value::<UiAssertInput>(parameters).is_ok());
        }
    }
    for parameters in [
        json!({}),
        json!({"assertion":{"condition":"exists"}}),
        json!({"assertion":{"query":{}}}),
        json!({"assertion":{"condition":"business_succeeded","query":{}}}),
        json!({"assertion":{"condition":"exists","query":{},"expected":true}}),
    ] {
        invalid(DebugTool::UiAssert, &parameters);
    }
}

#[test]
fn value_and_selection_assertions_enforce_types_and_exact_public_limits() {
    for assertion in [
        json!({"condition":"count","query":{},"expected":500}),
        json!({"condition":"value_equals","query":{},"expected":""}),
        json!({"condition":"value_equals","query":{},"expected":"a".repeat(16384)}),
        json!({"condition":"selected_equals","query":{},"expected":[]}),
        json!({"condition":"selected_equals","query":{},"expected":["", "a".repeat(1024)]}),
        json!({"condition":"selected_equals","query":{},"expected":["Mirror", "mirror"]}),
        json!({"condition":"selected_equals","query":{},"expected":(0..100).map(|index| format!("mode-{index}")).collect::<Vec<_>>()}),
    ] {
        valid(DebugTool::UiAssert, &json!({"assertion":assertion}));
    }
    for assertion in [
        json!({"condition":"count","query":{},"expected":501}),
        json!({"condition":"count","query":{},"expected":-1}),
        json!({"condition":"value_equals","query":{}}),
        json!({"condition":"value_equals","query":{},"expected":false}),
        json!({"condition":"value_equals","query":{},"expected":"a".repeat(16385)}),
        json!({"condition":"selected_equals","query":{},"expected":"mirror"}),
        json!({"condition":"selected_equals","query":{},"expected":[true]}),
        json!({"condition":"selected_equals","query":{},"expected":["a".repeat(1025)]}),
        json!({"condition":"selected_equals","query":{},"expected":["mirror", "mirror"]}),
        json!({"condition":"selected_equals","query":{},"expected":["", ""]}),
        json!({"condition":"selected_equals","query":{},"expected":(0..101).map(|index| format!("mode-{index}")).collect::<Vec<_>>()}),
    ] {
        invalid(DebugTool::UiAssert, &json!({"assertion":assertion}));
    }
}

#[test]
fn ui_action_accepts_every_action_and_preserves_original_field_names() {
    for kind in [
        "highlight",
        "click",
        "scroll",
        "fill",
        "select",
        "wait",
        "navigate",
        "pick",
    ] {
        let mut parameters = json!({"action":action(kind)});
        if kind != "navigate" {
            parameters["root_id"] = json!("root-1");
        }
        valid(DebugTool::UiAction, &parameters);
        let decoded: UiActionInput = serde_json::from_value(parameters.clone()).unwrap();
        valid(DebugTool::UiAction, &serde_json::to_value(decoded).unwrap());
    }
    valid(
        DebugTool::UiAction,
        &json!({"action":{"type":"fill","target":node(),"value":"","confirmed":true,"allowUnknownSideEffects":true}}),
    );
    valid(
        DebugTool::UiAction,
        &json!({"action":{"type":"select","target":node(),"values":[],"confirmed":true}}),
    );
    valid(
        DebugTool::UiAction,
        &json!({"action":{"type":"highlight","target":node()}}),
    );
}

#[test]
fn mutating_actions_require_nested_confirmation_even_with_other_authorization() {
    for kind in ["click", "scroll", "fill", "select", "navigate"] {
        let mut unconfirmed = action(kind);
        unconfirmed["confirmed"] = json!(false);
        if kind != "navigate" {
            unconfirmed["allowUnknownSideEffects"] = json!(true);
        }
        let failure = invalid(DebugTool::UiAction, &json!({"action":unconfirmed}));
        assert_eq!(details(&failure)["path"], "parameters.action.confirmed");
        unconfirmed.as_object_mut().unwrap().remove("confirmed");
        let failure = invalid(
            DebugTool::UiAction,
            &json!({"confirmed":true,"action":unconfirmed}),
        );
        assert_eq!(details(&failure)["path"], "parameters.action.confirmed");
    }
}

#[test]
fn action_missing_fields_report_exact_paths_and_never_echo_caller_values() {
    for (kind, missing) in [
        ("click", "target"),
        ("fill", "value"),
        ("select", "values"),
        ("wait", "assertion"),
        ("navigate", "path"),
    ] {
        let mut incomplete = action(kind);
        incomplete.as_object_mut().unwrap().remove(missing);
        if kind == "fill" {
            incomplete["target"]["id"] = json!("私有测试占位内容不得回显");
        }
        let failure = invalid(DebugTool::UiAction, &json!({"action":incomplete}));
        assert_eq!(
            details(&failure)["path"],
            format!("parameters.action.{missing}")
        );
        assert!(!failure.message.contains("私有测试占位内容不得回显"));
    }
    for missing in ["id", "generation", "revision"] {
        let mut incomplete = action("click");
        incomplete["target"]
            .as_object_mut()
            .unwrap()
            .remove(missing);
        let failure = invalid(DebugTool::UiAction, &json!({"action":incomplete}));
        assert_eq!(
            details(&failure)["path"],
            format!("parameters.action.target.{missing}")
        );
    }
}

#[test]
fn ui_tools_reject_wrong_layers_unknown_fields_and_conflicting_navigation_root() {
    for (tool, parameters) in [
        (
            DebugTool::UiTree,
            json!({"parameters":{"root_id":"root-1"}}),
        ),
        (DebugTool::UiQuery, json!({"query":{"root_id":"root-1"}})),
        (
            DebugTool::UiDiff,
            json!({"root_id":"root-1","before_id":"a","after_id":"b","parameters":{}}),
        ),
        (
            DebugTool::UiAssert,
            json!({"condition":"exists","query":{}}),
        ),
        (DebugTool::UiAction, action("click")),
        (
            DebugTool::UiAction,
            json!({"action":action("click"),"target":node()}),
        ),
        (
            DebugTool::UiAction,
            json!({"root_id":"root-1","action":action("navigate")}),
        ),
        (
            DebugTool::UiAction,
            json!({"action":{"type":"pick","target":node()}}),
        ),
        (
            DebugTool::UiAction,
            json!({"action":{"type":"click","target":node(),"confirmed":true,"allow_unknown_side_effects":true}}),
        ),
        (
            DebugTool::UiAction,
            json!({"action":{"type":"wait","assertion":{"condition":"exists","query":{}},"timeout_ms":1000}}),
        ),
        (
            DebugTool::UiAction,
            json!({"action":{"type":"evaluate","script":"不得回显的占位正文"}}),
        ),
    ] {
        let failure = invalid(tool, &parameters);
        assert!(
            details(&failure)["path"]
                .as_str()
                .unwrap()
                .starts_with("parameters")
        );
        assert!(!failure.message.contains("不得回显的占位正文"));
    }
}

#[test]
fn node_references_use_safe_integer_generations_and_bounded_nonempty_ids() {
    let mut click = action("click");
    click["target"] = json!({"id":"节点引用","generation":9_007_199_254_740_991_u64,"revision":0});
    valid(DebugTool::UiAction, &json!({"action":click}));
    for (field, value) in [
        ("id", json!("")),
        ("id", json!("   ")),
        ("id", json!("a".repeat(257))),
        ("generation", json!(-1)),
        ("generation", json!(9_007_199_254_740_992_u64)),
        ("revision", json!(1.5)),
        ("revision", json!("2")),
    ] {
        let mut click = action("click");
        click["target"][field] = value;
        invalid(DebugTool::UiAction, &json!({"action":click}));
    }
}

#[test]
fn action_text_selection_and_wait_budgets_enforce_inclusive_limits() {
    for fill in ["".to_string(), "a".repeat(16384)] {
        valid(
            DebugTool::UiAction,
            &json!({"action":{"type":"fill","target":node(),"value":fill,"confirmed":true}}),
        );
    }
    invalid(
        DebugTool::UiAction,
        &json!({"action":{"type":"fill","target":node(),"value":"a".repeat(16385),"confirmed":true}}),
    );
    for values in [json!(["a".repeat(1024)]), json!(vec!["mode"; 100])] {
        valid(
            DebugTool::UiAction,
            &json!({"action":{"type":"select","target":node(),"values":values,"confirmed":true}}),
        );
    }
    for values in [
        json!([""]),
        json!(["   "]),
        json!(["a".repeat(1025)]),
        json!(vec!["mode"; 101]),
    ] {
        invalid(
            DebugTool::UiAction,
            &json!({"action":{"type":"select","target":node(),"values":values,"confirmed":true}}),
        );
    }
    for budget in [0, 10000] {
        let mut wait = action("wait");
        wait["timeoutMs"] = json!(budget);
        valid(DebugTool::UiAction, &json!({"action":wait}));
    }
    for budget in [json!(-1), json!(10001), json!("1000")] {
        let mut wait = action("wait");
        wait["timeoutMs"] = budget;
        invalid(DebugTool::UiAction, &json!({"action":wait}));
    }
}

fn expectation(kind: &str) -> Value {
    match kind {
        "ui" => {
            json!({"kind":"ui","assertion":{"condition":"value_equals","query":{"id":"node-1"},"expected":"地址"}})
        }
        "data" => {
            json!({"kind":"data","source_id":"test.status","checks":[{"pointer":"/connected","equals":true}]})
        }
        _ => unreachable!("只使用公开的检查种类"),
    }
}

#[test]
fn expectations_accept_ui_and_data_branches_and_inclusive_timeout_limits() {
    for kind in ["ui", "data"] {
        for budget in [None, Some(0), Some(10000)] {
            let mut expect = expectation(kind);
            if let Some(budget) = budget {
                expect["timeout_ms"] = json!(budget);
            }
            if kind == "data" {
                expect["query"] = json!({"device":"selected"});
            }
            valid(
                DebugTool::UiAction,
                &json!({"action":action("click"),"expect":expect}),
            );
        }
        for budget in [json!(-1), json!(10001), json!(1.5), json!("3000")] {
            let mut expect = expectation(kind);
            expect["timeout_ms"] = budget;
            invalid(
                DebugTool::UiAction,
                &json!({"action":action("click"),"expect":expect}),
            );
        }
    }
    for expect in [
        json!({"kind":"ui"}),
        json!({"kind":"data","checks":[{"pointer":"/connected","equals":true}]}),
        json!({"kind":"data","source_id":" ","checks":[{"pointer":"/connected","equals":true}]}),
        json!({"kind":"data","source_id":"a".repeat(129),"checks":[{"pointer":"/connected","equals":true}]}),
        json!({"kind":"data","source_id":"test.status","checks":[]}),
        json!({"kind":"data","source_id":"test.status","checks":vec![json!({"pointer":"/connected","equals":true});17]}),
        json!({"kind":"ui","assertion":{"condition":"exists","query":{}},"timeoutMs":3000}),
        json!({"kind":"script","expression":"connected == true"}),
    ] {
        invalid(
            DebugTool::UiAction,
            &json!({"action":action("click"),"expect":expect}),
        );
    }
}

#[test]
fn data_checks_accept_rfc6901_fields_and_reject_relative_or_invalid_escapes() {
    for pointer in ["/", "/connected", "/设备/0/在线", "/a~0b/~1/0", "/~01"] {
        let mut expect = expectation("data");
        expect["checks"] = json!([{"pointer":pointer,"equals":null}]);
        valid(
            DebugTool::UiAction,
            &json!({"action":action("click"),"expect":expect}),
        );
    }
    let mut maximum_pointer = expectation("data");
    maximum_pointer["checks"][0]["pointer"] = json!(format!("/{}", "a".repeat(1023)));
    valid(
        DebugTool::UiAction,
        &json!({"action":action("click"),"expect":maximum_pointer}),
    );
    maximum_pointer["checks"][0]["pointer"] = json!(format!("/{}", "a".repeat(1024)));
    invalid(
        DebugTool::UiAction,
        &json!({"action":action("click"),"expect":maximum_pointer}),
    );
    let mut expect = expectation("data");
    expect["checks"] = json!(vec![json!({"pointer":"/connected","equals":true}); 16]);
    valid(
        DebugTool::UiAction,
        &json!({"action":action("click"),"expect":expect}),
    );
    for pointer in [
        "",
        "connected",
        "#/connected",
        "/~2",
        "/trailing~",
        "/~",
        "/a~x/b",
    ] {
        let mut expect = expectation("data");
        expect["checks"][0]["pointer"] = json!(pointer);
        invalid(
            DebugTool::UiAction,
            &json!({"action":action("click"),"expect":expect}),
        );
    }
    for check in [
        json!({"equals":true}),
        json!({"pointer":"/connected"}),
        json!({"pointer":"/connected","equals":true,"expression":"extra"}),
    ] {
        let mut expect = expectation("data");
        expect["checks"] = json!([check]);
        invalid(
            DebugTool::UiAction,
            &json!({"action":action("click"),"expect":expect}),
        );
    }
}

#[test]
fn omitted_legacy_fields_and_default_budgets_deserialize_without_wire_renaming() {
    let snapshot: UiSnapshotInput = serde_json::from_value(json!({})).unwrap();
    assert_eq!((snapshot.offset, snapshot.limit), (0, 500));
    assert!(snapshot.root_id.is_none() && snapshot.snapshot_id.is_none());
    let overview: UiOverviewInput = serde_json::from_value(json!({"view":"overview"})).unwrap();
    assert_eq!((overview.offset, overview.limit), (0, 500));
    let query: UiQueryInput = serde_json::from_value(json!({"root_id":"root-1"})).unwrap();
    assert_eq!(serde_json::to_value(query.query).unwrap(), json!({}));
    let highlight: UiActionInput =
        serde_json::from_value(json!({"action":{"type":"highlight","target":node()}})).unwrap();
    assert!(highlight.root_id.is_none() && highlight.expect.is_none());
    assert!(matches!(
        highlight.action,
        UiAction::Highlight {
            confirmed: false,
            allow_unknown_side_effects: false,
            ..
        }
    ));
    let wait: UiActionInput = serde_json::from_value(json!({"action":action("wait")})).unwrap();
    assert!(matches!(
        wait.action,
        UiAction::Wait {
            timeout_ms: None,
            ..
        }
    ));
    for kind in ["ui", "data"] {
        let check: UiActionExpectation = serde_json::from_value(expectation(kind)).unwrap();
        match check {
            UiActionExpectation::Ui { timeout_ms, .. }
            | UiActionExpectation::Data { timeout_ms, .. } => assert_eq!(timeout_ms, 3000),
        }
    }
    let plan: AutomationInput = serde_json::from_value(
        json!({"confirmed":false,"steps":[{"id":"read","tool":"ui_query","parameters":{}}]}),
    )
    .unwrap();
    assert!(plan.stop_on_failure);
    assert!(plan.steps[0].bind.is_none() && plan.steps[0].label.is_none());
}

fn step(id: &str, tool: &str, parameters: Value) -> Value {
    json!({"id":id,"tool":tool,"parameters":parameters})
}

fn plan(steps: Vec<Value>) -> Value {
    json!({"confirmed":true,"steps":steps})
}

fn bind_target(mut step: Value, source: &str) -> Value {
    step["parameters"]["action"]
        .as_object_mut()
        .unwrap()
        .remove("target");
    step["bind"] = json!({"target_from_step":source});
    step
}

#[test]
fn automation_accepts_every_step_tool_and_both_invoke_branches() {
    let steps = vec![
        step("inspect", "inspect", json!({})),
        step("catalog", "data_catalog", json!({})),
        step("read", "data_read", json!({"source_id":"test.status"})),
        step("tree", "ui_tree", json!({"view":"overview"})),
        step(
            "query",
            "ui_query",
            json!({"root_id":"root-1","query":{"role":"textbox"}}),
        ),
        step(
            "assert",
            "ui_assert",
            json!({"assertion":{"condition":"value_equals","query":{},"expected":"设备地址"}}),
        ),
        step(
            "write",
            "data_write",
            json!({"source_id":"test.status","expected_revision":"r1","value":{"name":"示例"},"confirmed":true}),
        ),
        step(
            "command",
            "invoke",
            json!({"kind":"command","id":"test.command","input":{},"confirmed":true,"allow_unknown_side_effects":true}),
        ),
        step(
            "service",
            "invoke",
            json!({"kind":"service","id":"test.service","version":"1","input":{},"confirmed":true,"allow_unknown_side_effects":true,"include_result":true}),
        ),
    ];
    valid(DebugTool::AutomationRun, &plan(steps));
    for kind in [
        "highlight",
        "click",
        "scroll",
        "fill",
        "select",
        "wait",
        "navigate",
    ] {
        valid(
            DebugTool::AutomationRun,
            &plan(vec![step(
                "action",
                "ui_action",
                json!({"action":action(kind)}),
            )]),
        );
    }
}

#[test]
fn automation_accepts_every_bound_node_action_without_rewriting_original_parameters() {
    for kind in ["highlight", "click", "scroll", "fill", "select"] {
        let query = step(
            "query",
            "ui_query",
            json!({"query":{"role":"textbox","limit":1}}),
        );
        let mut bound = bind_target(
            step(
                "action",
                "ui_action",
                json!({"root_id":"root-1","action":action(kind)}),
            ),
            "query",
        );
        bound["label"] = json!("复用已查询节点");
        bound["parameters"]["expect"] = expectation("ui");
        let parameters = plan(vec![query, bound]);
        let before = parameters.clone();
        valid(DebugTool::AutomationRun, &parameters);
        assert_eq!(parameters, before);
        assert!(
            parameters
                .pointer("/steps/1/parameters/action/target")
                .is_none()
        );
    }
}

#[test]
fn automation_fixed_target_and_binding_are_exclusive_in_schema_and_runtime() {
    let query = step("query", "ui_query", json!({}));
    let fixed = step("click", "ui_action", json!({"action":action("click")}));
    valid(
        DebugTool::AutomationRun,
        &plan(vec![query.clone(), fixed.clone()]),
    );
    let mut conflicting = fixed;
    conflicting["bind"] = json!({"target_from_step":"query"});
    invalid(DebugTool::AutomationRun, &plan(vec![query, conflicting]));
}

#[test]
fn automation_preflight_rejects_missing_forward_wrong_tool_bindings_and_missing_targets() {
    let query = step("query", "ui_query", json!({}));
    let bound = bind_target(
        step("click", "ui_action", json!({"action":action("click")})),
        "query",
    );
    for source in ["missing", "click"] {
        let mut invalid_bound = bound.clone();
        invalid_bound["bind"]["target_from_step"] = json!(source);
        let parameters = plan(vec![query.clone(), invalid_bound]);
        assert_eq!(
            validate_debug_command(DebugTool::AutomationRun, &parameters)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
    }
    for parameters in [
        plan(vec![bound.clone(), query.clone()]),
        plan(vec![step("query", "inspect", json!({})), bound.clone()]),
        plan(vec![
            query.clone(),
            json!({"id":"click","tool":"ui_action","parameters":{"action":{"type":"click","confirmed":true}},"bind":{}}),
        ]),
    ] {
        assert_eq!(
            validate_debug_command(DebugTool::AutomationRun, &parameters)
                .unwrap_err()
                .code,
            ErrorCode::InvalidInput
        );
    }
    for kind in ["wait", "navigate", "pick"] {
        let mut invalid_bound = step("action", "ui_action", json!({"action":action(kind)}));
        invalid_bound["bind"] = json!({"target_from_step":"query"});
        invalid(
            DebugTool::AutomationRun,
            &plan(vec![query.clone(), invalid_bound]),
        );
    }
}

#[test]
fn automation_plan_confirmation_never_replaces_individual_action_confirmation() {
    for kind in ["click", "scroll", "fill", "select", "navigate"] {
        let mut unconfirmed = action(kind);
        unconfirmed["confirmed"] = json!(false);
        let failure = invalid(
            DebugTool::AutomationRun,
            &plan(vec![step(
                "action",
                "ui_action",
                json!({"action":unconfirmed}),
            )]),
        );
        assert_eq!(
            details(&failure)["path"],
            "parameters.steps.0.parameters.action.confirmed"
        );
    }
    let mut parameters = plan(vec![step(
        "action",
        "ui_action",
        json!({"action":action("click")}),
    )]);
    parameters["confirmed"] = json!(false);
    assert_eq!(
        validate_debug_command(DebugTool::AutomationRun, &parameters)
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    let mut read_only = plan(vec![step("query", "ui_query", json!({}))]);
    read_only["confirmed"] = json!(false);
    valid(DebugTool::AutomationRun, &read_only);
}

#[derive(Default)]
struct PlanClock(AtomicU64);

impl DebuggerClock for PlanClock {
    fn now(&self) -> Duration {
        Duration::from_millis(self.0.load(Ordering::Relaxed))
    }
}

fn session_fixture() -> (
    Arc<PlanClock>,
    DebuggerService,
    BrowserInstance,
    DebugSession,
) {
    let clock = Arc::new(PlanClock::default());
    let service = DebuggerService::with_clock(DebuggerConfig::default(), clock.clone()).unwrap();
    let instance = service
        .register_instance(BridgeRegistration {
            plugins: vec![BridgePlugin {
                plugin_id: "test.ui-contract".into(),
                generation: Some("g1".into()),
                version: None,
            }],
        })
        .unwrap();
    let session = service
        .open_session(SessionRequest {
            target: DebugTarget {
                target_kind: TargetKind::Browser,
                instance_id: Some(instance.instance_id.clone()),
                plugin_id: "test.ui-contract".into(),
                generation: Some("g1".into()),
                version: None,
            },
        })
        .unwrap();
    (clock, service, instance, session)
}

fn claim(service: &DebuggerService, instance: &BrowserInstance) -> BridgeBatch {
    service
        .poll_batch(
            &BridgePoll {
                instance_id: instance.instance_id.clone(),
                limit: 4,
            },
            None,
        )
        .unwrap()
        .0
}

fn events(service: &DebuggerService, session: &DebugSession) -> Value {
    serde_json::to_value(
        service
            .events(EventQuery {
                session_id: Some(session.session_id.clone()),
                after: 0,
                limit: 200,
            })
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn automation_last_step_failure_leaves_entire_plan_unqueued_and_next_plan_usable() {
    let (_, service, instance, session) = session_fixture();
    let before = events(&service, &session);
    let mut incomplete = action("fill");
    incomplete.as_object_mut().unwrap().remove("value");
    let parameters = plan(vec![
        step("first", "ui_action", json!({"action":action("click")})),
        step("last", "ui_action", json!({"action":incomplete})),
    ]);
    let failure = service
        .enqueue(DebugCommandRequest {
            session_id: session.session_id.clone(),
            tool: DebugTool::AutomationRun,
            parameters,
        })
        .unwrap_err();
    assert_eq!(failure.code, ErrorCode::InvalidInput);
    assert_eq!(
        details(&failure)["path"],
        "parameters.steps.1.parameters.action.value"
    );
    assert_eq!(events(&service, &session), before);
    assert!(claim(&service, &instance).commands.is_empty());

    let valid_plan = plan(vec![step("next", "ui_query", json!({}))]);
    let receipt = service
        .enqueue(DebugCommandRequest {
            session_id: session.session_id,
            tool: DebugTool::AutomationRun,
            parameters: valid_plan.clone(),
        })
        .unwrap();
    let batch = claim(&service, &instance);
    assert_eq!(batch.commands.len(), 1);
    assert_eq!(batch.commands[0].command_id, receipt.command_id);
    assert_eq!(batch.commands[0].parameters, valid_plan);
}

#[test]
fn automation_accepts_thirty_two_unique_steps_but_rejects_thirty_three_before_admission() {
    let (_, service, instance, session) = session_fixture();
    let steps: Vec<_> = (0..32)
        .map(|index| step(&format!("step-{index}"), "ui_query", json!({})))
        .collect();
    valid(DebugTool::AutomationRun, &plan(steps.clone()));
    let mut oversized = steps.clone();
    oversized.push(step("step-32", "ui_query", json!({})));
    let before = events(&service, &session);
    invalid(DebugTool::AutomationRun, &plan(oversized.clone()));
    assert_eq!(
        service
            .enqueue(DebugCommandRequest {
                session_id: session.session_id.clone(),
                tool: DebugTool::AutomationRun,
                parameters: plan(oversized),
            })
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
    assert_eq!(events(&service, &session), before);
    assert!(claim(&service, &instance).commands.is_empty());

    let receipt = service
        .enqueue(DebugCommandRequest {
            session_id: session.session_id,
            tool: DebugTool::AutomationRun,
            parameters: plan(steps),
        })
        .unwrap();
    let batch = claim(&service, &instance);
    assert_eq!(batch.commands.len(), 1);
    assert_eq!(batch.commands[0].command_id, receipt.command_id);
    assert_eq!(
        batch.commands[0].parameters["steps"]
            .as_array()
            .unwrap()
            .len(),
        32
    );
}

#[test]
fn automation_waits_share_one_original_thirty_second_deadline() {
    let (clock, service, instance, session) = session_fixture();
    let steps = (0..32)
        .map(|index| {
            let mut wait = action("wait");
            wait["timeoutMs"] = json!(10000);
            step(
                &format!("wait-{index}"),
                "ui_action",
                json!({"action":wait}),
            )
        })
        .collect();
    let receipt = service
        .enqueue(DebugCommandRequest {
            session_id: session.session_id,
            tool: DebugTool::AutomationRun,
            parameters: plan(steps),
        })
        .unwrap();
    assert_eq!(receipt.timeout_ms, 30_000);
    clock.0.store(8_000, Ordering::Relaxed);
    let batch = claim(&service, &instance);
    assert_eq!(batch.commands.len(), 1);
    assert_eq!(batch.commands[0].remaining_ms, 22_000);
    clock.0.store(29_999, Ordering::Relaxed);
    assert_eq!(
        service.command_result(&receipt.command_id).unwrap().state,
        CommandState::Delivered
    );
    clock.0.store(30_000, Ordering::Relaxed);
    assert_eq!(
        service.command_result(&receipt.command_id).unwrap().state,
        CommandState::TimedOutUnconfirmed
    );
    assert!(claim(&service, &instance).commands.is_empty());
    assert_eq!(
        service
            .acknowledge(BridgeAck {
                instance_id: instance.instance_id,
                command_id: receipt.command_id.clone(),
                plugin_id: "test.ui-contract".into(),
                generation: Some("g1".into()),
                success: true,
                response: json!({"status":"succeeded"}),
            })
            .unwrap_err()
            .code,
        ErrorCode::ExpiredCommand
    );
    assert!(
        service
            .command_result(&receipt.command_id)
            .unwrap()
            .response
            .is_none()
    );
}

#[test]
fn automation_preserves_legacy_label_stop_policy_and_null_binding_inputs() {
    let parameters = json!({"confirmed":false,"stop_on_failure":false,"steps":[
        {"id":"query","label":"读取当前界面","tool":"ui_query","parameters":{},"bind":null}
    ]});
    valid(DebugTool::AutomationRun, &parameters);
    let parsed: AutomationInput = serde_json::from_value(parameters.clone()).unwrap();
    assert!(!parsed.stop_on_failure);
    assert_eq!(parsed.steps[0].label.as_deref(), Some("读取当前界面"));
    let (_, service, instance, session) = session_fixture();
    service
        .enqueue(DebugCommandRequest {
            session_id: session.session_id,
            tool: DebugTool::AutomationRun,
            parameters: parameters.clone(),
        })
        .unwrap();
    assert_eq!(
        claim(&service, &instance).commands[0].parameters,
        parameters
    );
}

#[test]
fn automation_rejects_empty_binding_objects_but_accepts_omitted_or_null_bindings() {
    for template in [
        step("query", "ui_query", json!({})),
        step("click", "ui_action", json!({"action":action("click")})),
    ] {
        for binding in [
            json!({}),
            json!({"target_from_step":null}),
            json!({"revision_from_step":null}),
            json!({"target_from_step":null,"revision_from_step":null}),
        ] {
            let mut candidate = template.clone();
            candidate["bind"] = binding;
            let parameters = plan(vec![candidate]);
            let decoded: AutomationInput = serde_json::from_value(parameters.clone()).unwrap();
            let empty = decoded.steps[0].bind.as_ref().unwrap();
            assert!(empty.target_from_step.is_none() && empty.revision_from_step.is_none());

            // 反序列化只识别形状；历史准入始终拒绝显式提供但没有来源的绑定对象。
            let failure = invalid(DebugTool::AutomationRun, &parameters);
            assert!(failure.message.contains("步骤绑定不能为空"));
            let (_, service, instance, session) = session_fixture();
            let before = events(&service, &session);
            assert_eq!(
                service
                    .enqueue(DebugCommandRequest {
                        session_id: session.session_id.clone(),
                        tool: DebugTool::AutomationRun,
                        parameters,
                    })
                    .unwrap_err()
                    .code,
                ErrorCode::InvalidInput
            );
            assert_eq!(events(&service, &session), before);
            assert!(claim(&service, &instance).commands.is_empty());
        }

        for binding in [None, Some(Value::Null)] {
            let mut candidate = template.clone();
            if let Some(binding) = binding {
                candidate["bind"] = binding;
            }
            let parameters = plan(vec![candidate]);
            let decoded: AutomationInput = serde_json::from_value(parameters.clone()).unwrap();
            assert!(decoded.steps[0].bind.is_none());
            valid(DebugTool::AutomationRun, &parameters);
            let (_, service, instance, session) = session_fixture();
            service
                .enqueue(DebugCommandRequest {
                    session_id: session.session_id,
                    tool: DebugTool::AutomationRun,
                    parameters: parameters.clone(),
                })
                .unwrap();
            let batch = claim(&service, &instance);
            assert_eq!(batch.commands.len(), 1);
            assert_eq!(batch.commands[0].parameters, parameters);
        }
    }
}
