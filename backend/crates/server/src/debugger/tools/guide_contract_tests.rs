//! 指南使用真实返回示例回验公开参数，不启动服务、会话或浏览器。

use super::{command_query::CommandQuery, guide, *};
use apk_application::debugger::{ui_contract::UI_CONTRACT_REVISION, validate_debug_command};

fn read(input: Value) -> Value {
    guide::read(input).unwrap_or_else(|failure| panic!("读取指南失败：{}", failure.1.message))
}

#[test]
fn guide_default_and_each_topic_publish_current_revision_and_read_only_metadata() {
    let default = read(json!({}));
    assert_eq!(default["topic"], "quickstart");
    assert_eq!(default, read(json!({"topic":"quickstart"})));
    for topic in ["quickstart", "ui", "automation"] {
        let output = read(json!({"topic":topic}));
        assert_eq!(output["revision"], UI_CONTRACT_REVISION);
        assert_eq!(output["topic"], topic);
        assert!(!output["content"].as_str().unwrap().is_empty());
        assert!(!output["examples"].as_array().unwrap().is_empty());
    }
    let tool = tools()
        .into_iter()
        .find(|tool| tool.name == "deviceforge.debug_guide")
        .unwrap();
    let annotations = tool.annotations.unwrap();
    assert_eq!(annotations.read_only_hint, Some(true));
    assert_eq!(annotations.destructive_hint, Some(false));
    let schema = serde_json::to_value(tool.input_schema).unwrap();
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["properties"]["topic"]["default"], "quickstart");
    let topics = schema["properties"]["topic"]["enum"].as_array().unwrap();
    assert_eq!(topics.len(), 3);
    for topic in ["quickstart", "ui", "automation"] {
        assert!(topics.iter().any(|candidate| candidate == topic));
    }
    assert!(
        !schema["required"]
            .as_array()
            .is_some_and(|fields| fields.iter().any(|field| field == "topic"))
    );
}

#[test]
fn every_guide_example_uses_registered_tool_and_actual_input_contract() {
    let registered = tools();
    for topic in ["quickstart", "ui", "automation"] {
        let output = read(json!({"topic":topic}));
        for example in output["examples"].as_array().unwrap() {
            let name = example["tool"].as_str().unwrap();
            let input = example["input"].clone();
            assert!(manages(name), "指南引用未登记工具：{name}");
            assert!(registered.iter().any(|tool| tool.name == name));
            if let Some(tool) = ui_tools::tool(name) {
                let decoded = ui_tools::decode(tool, input)
                    .unwrap_or_else(|failure| panic!("{name} 指南示例无效：{}", failure.1.message));
                assert!(!decoded.session_id.is_empty());
                assert_eq!(validate_debug_command(tool, &decoded.parameters), Ok(()));
            } else {
                match name {
                    "deviceforge.debug_targets" => assert_eq!(input, json!({})),
                    "deviceforge.debug_session" => {
                        assert!(serde_json::from_value::<SessionInput>(input).is_ok());
                    }
                    "deviceforge.debug_command" => {
                        assert!(serde_json::from_value::<CommandQuery>(input).is_ok());
                    }
                    "deviceforge.debug_inspect" | "deviceforge.debug_automation_run" => {
                        let decoded: CommandInput = serde_json::from_value(input).unwrap();
                        let tool = if name.ends_with("automation_run") {
                            DebugTool::AutomationRun
                        } else {
                            DebugTool::Inspect
                        };
                        assert!(!decoded.session_id.is_empty());
                        assert_eq!(validate_debug_command(tool, &decoded.parameters), Ok(()));
                    }
                    _ => panic!("新增指南工具必须补实际契约检查：{name}"),
                }
            }
        }
    }
}

#[test]
fn guide_rejects_unknown_topic_or_fields_without_echoing_caller_content() {
    for input in [
        json!({"topic":"不得回显的占位主题"}),
        json!({"topic":"ui","private":"不得回显的占位正文"}),
        json!({"topic":null}),
        json!({"topic":42}),
        json!([]),
    ] {
        let failure = guide::read(input).err().expect("指南输入也须严格校验");
        assert_eq!(failure.1.code, "debugger_invalid_input");
        assert!(!failure.1.message.contains("不得回显"));
    }
}

#[test]
fn public_guide_returns_inline_content_without_host_source_or_physical_document_paths() {
    for topic in ["quickstart", "ui", "automation"] {
        let output = read(json!({"topic":topic}));
        let fields = output.as_object().unwrap();
        assert_eq!(fields.len(), 4);
        for field in ["revision", "topic", "content", "examples"] {
            assert!(fields.contains_key(field));
        }
        let public_text = serde_json::to_string(&output)
            .unwrap()
            .replace('\\', "/")
            .to_ascii_lowercase();
        for forbidden in [
            "g:/",
            "g://",
            "c:/",
            "c://",
            "file://",
            "backend/",
            "frontend/",
            "crates/",
            "src/",
            "docs/",
            "source_path",
            "source_file",
            "document_path",
            "physical_path",
        ] {
            assert!(
                !public_text.contains(forbidden),
                "{topic} 指南不能暴露宿主路径：{forbidden}"
            );
        }
    }
}

#[test]
fn four_step_guide_binds_targets_and_verifies_input_separately_from_business_state() {
    let output = read(json!({"topic":"automation"}));
    let parameters = &output["examples"][0]["input"]["parameters"];
    assert_eq!(
        validate_debug_command(DebugTool::AutomationRun, parameters),
        Ok(())
    );
    let steps = parameters["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 4);
    for (action_index, query_index) in [(1, 0), (3, 2)] {
        assert_eq!(steps[query_index]["tool"], "ui_query");
        assert_eq!(steps[action_index]["tool"], "ui_action");
        assert_eq!(
            steps[action_index]["bind"]["target_from_step"],
            steps[query_index]["id"]
        );
        assert!(
            steps[action_index]["parameters"]["action"]
                .get("target")
                .is_none()
        );
        assert_eq!(
            steps[action_index]["parameters"]["action"]["confirmed"],
            true
        );
    }
    assert_eq!(steps[1]["parameters"]["expect"]["kind"], "ui");
    assert_eq!(
        steps[1]["parameters"]["expect"]["assertion"]["condition"],
        "value_equals"
    );
    assert_eq!(
        steps[1]["parameters"]["expect"]["assertion"]["expected"],
        steps[1]["parameters"]["action"]["value"]
    );
    assert_eq!(steps[3]["parameters"]["expect"]["kind"], "data");
    assert_eq!(
        steps[3]["parameters"]["expect"]["checks"][0],
        json!({"pointer":"/connected","equals":true})
    );
}
