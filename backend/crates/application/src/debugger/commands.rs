//! 数据和自动调试只定义传输与准入；实际读写和逐步执行仍由选定浏览器处理。

use super::{
    DebugTool, ErrorCode, Result,
    ui_contract::{self, UiAssertInput, UiQueryInput, UiTreeInput},
    validation::{self, error},
};
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{borrow::Cow, collections::BTreeMap};

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DataCatalogInput {}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DataReadInput {
    pub source_id: String,
    #[serde(default)]
    pub query: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DataWriteInput {
    pub source_id: String,
    pub expected_revision: String,
    pub value: Value,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AutomationStepTool {
    Inspect,
    DataCatalog,
    DataRead,
    UiTree,
    UiQuery,
    UiAssert,
    UiAction,
    DataWrite,
    Invoke,
}

impl AutomationStepTool {
    fn command(self) -> DebugTool {
        match self {
            Self::Inspect => DebugTool::Inspect,
            Self::DataCatalog => DebugTool::DataCatalog,
            Self::DataRead => DebugTool::DataRead,
            Self::UiTree => DebugTool::UiTree,
            Self::UiQuery => DebugTool::UiQuery,
            Self::UiAssert => DebugTool::UiAssert,
            Self::UiAction => DebugTool::UiAction,
            Self::DataWrite => DebugTool::DataWrite,
            Self::Invoke => DebugTool::Invoke,
        }
    }
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AutomationBinding {
    #[serde(default)]
    pub target_from_step: Option<String>,
    #[serde(default)]
    pub revision_from_step: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AutomationStep {
    pub id: String,
    /// Agent 提供的业务展示名称；不参与绑定或执行状态判定。
    #[serde(
        default,
        deserialize_with = "display_label",
        skip_serializing_if = "Option::is_none"
    )]
    pub label: Option<String>,
    pub tool: AutomationStepTool,
    pub parameters: Value,
    #[serde(default)]
    pub bind: Option<AutomationBinding>,
}

/// 模式按步骤工具公开真实参数；执行仍反序列化为原来的 Value，保持传输字节兼容。
impl JsonSchema for AutomationStep {
    fn schema_name() -> Cow<'static, str> {
        "AutomationStep".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut branches = Vec::new();
        for (tool, parameters) in [
            ("inspect", generator.subschema_for::<DataCatalogInput>()),
            (
                "data_catalog",
                generator.subschema_for::<DataCatalogInput>(),
            ),
            ("data_read", generator.subschema_for::<DataReadInput>()),
            ("ui_tree", generator.subschema_for::<UiTreeInput>()),
            ("ui_query", generator.subschema_for::<UiQueryInput>()),
            ("ui_assert", generator.subschema_for::<UiAssertInput>()),
            (
                "ui_action",
                ui_contract::automation_action_schema(generator, false),
            ),
            ("data_write", generator.subschema_for::<DataWriteInput>()),
            ("invoke", generator.subschema_for::<BrowserInvokeInput>()),
        ] {
            branches.push(step_schema(tool, parameters.to_value(), None));
        }
        branches.push(step_schema(
            "ui_action",
            ui_contract::automation_action_schema(generator, true).to_value(),
            Some("target_from_step"),
        ));
        let mut write = DataWriteInput::json_schema(generator).to_value();
        write["required"]
            .as_array_mut()
            .expect("写入必填字段为数组")
            .retain(|field| field != "expected_revision");
        write["properties"]
            .as_object_mut()
            .expect("写入字段为对象")
            .remove("expected_revision");
        branches.push(step_schema("data_write", write, Some("revision_from_step")));
        serde_json::from_value(json!({"oneOf":branches})).expect("自动调试步骤模式为对象")
    }
}

fn step_schema(tool: &str, parameters: Value, binding: Option<&str>) -> Value {
    let mut schema = json!({"type":"object","additionalProperties":false,
        "required":["id","tool","parameters"],"properties":{
            "id":{"type":"string","minLength":1,"maxLength":128},
            "label":{"type":"string","minLength":1,"maxLength":80,"pattern":"\\S"},
            "tool":{"const":tool},"parameters":parameters,"bind":{"type":"null"}}});
    if let Some(binding) = binding {
        schema["required"]
            .as_array_mut()
            .expect("步骤必填字段为数组")
            .push(json!("bind"));
        schema["properties"]["bind"] = json!({"type":"object","additionalProperties":false,
            "required":[binding],"properties":{binding:{"type":"string","minLength":1,"maxLength":128}}});
    }
    schema
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum BrowserInvokeInput {
    Command {
        id: ui_contract::UiText,
        input: Value,
        #[schemars(extend("const" = true))]
        confirmed: bool,
        #[schemars(extend("const" = true))]
        allow_unknown_side_effects: bool,
        #[serde(default)]
        include_result: bool,
    },
    Service {
        id: ui_contract::UiText,
        version: ui_contract::UiText,
        input: Value,
        #[schemars(extend("const" = true))]
        confirmed: bool,
        #[schemars(extend("const" = true))]
        allow_unknown_side_effects: bool,
        #[serde(default)]
        include_result: bool,
    },
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AutomationInput {
    #[schemars(length(min = 1, max = 32))]
    pub steps: Vec<AutomationStep>,
    pub confirmed: bool,
    #[serde(default = "stop_on_failure")]
    pub stop_on_failure: bool,
}

fn display_label<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

fn stop_on_failure() -> bool {
    true
}

fn decode<T: serde::de::DeserializeOwned>(parameters: &Value) -> Result<T> {
    serde_json::from_value(parameters.clone())
        .map_err(|_| error(ErrorCode::InvalidInput, "数据或自动调试参数不符合工具模式"))
}

pub(super) fn validate(tool: DebugTool, parameters: &Value) -> Result<()> {
    match tool {
        DebugTool::UiTree
        | DebugTool::UiQuery
        | DebugTool::UiDiff
        | DebugTool::UiAssert
        | DebugTool::UiAction => {
            validation::payload(parameters)?;
            ui_contract::validate(tool, parameters)
        }
        DebugTool::DataCatalog => {
            let _: DataCatalogInput = decode(parameters)?;
            validation::payload(parameters)
        }
        DebugTool::DataRead => {
            let input: DataReadInput = decode(parameters)?;
            validation::identifier(&input.source_id)?;
            validation::payload(parameters)
        }
        DebugTool::DataWrite => validate_write(parameters),
        DebugTool::AutomationRun => validate_automation(parameters),
        DebugTool::Invoke => validate_invoke(parameters),
        _ => validation::payload(parameters),
    }
}

fn validate_invoke(parameters: &Value) -> Result<()> {
    validation::payload(parameters)?;
    let input: BrowserInvokeInput = decode(parameters)?;
    let (confirmed, allowed) = match input {
        BrowserInvokeInput::Command {
            confirmed,
            allow_unknown_side_effects,
            ..
        }
        | BrowserInvokeInput::Service {
            confirmed,
            allow_unknown_side_effects,
            ..
        } => (confirmed, allow_unknown_side_effects),
    };
    if !confirmed || !allowed {
        return Err(error(
            ErrorCode::InvalidInput,
            "试调用必须确认本次调用并单独允许未知副作用",
        ));
    }
    Ok(())
}

fn validate_write(parameters: &Value) -> Result<()> {
    let input: DataWriteInput = decode(parameters)?;
    validation::identifier(&input.source_id)?;
    validation::identifier(&input.expected_revision)?;
    if !input.confirmed {
        return Err(error(
            ErrorCode::InvalidInput,
            "数据写入必须明确确认本次完整替换",
        ));
    }
    validation::encoded_size(&input.value, 256 * 1024)?;
    validation::extended_payload(parameters, 256 * 1024 + 4096)
}

fn validate_automation(parameters: &Value) -> Result<()> {
    validation::extended_payload(parameters, 1024 * 1024)?;
    let input: AutomationInput = decode(parameters).map_err(|_| ui_contract::invalid(
        "parameters.steps", "步骤包含 id、tool、parameters；只使用公开的工具与字段层级",
        json!({"steps":[{"id":"overview","tool":"ui_tree","parameters":{"view":"overview"}}],"confirmed":false}),
    ))?;
    if input.steps.is_empty() || input.steps.len() > 32 {
        return Err(error(
            ErrorCode::InvalidInput,
            "自动调试必须包含1到32个步骤",
        ));
    }
    let mut previous = BTreeMap::<&str, &AutomationStep>::new();
    for (index, step) in input.steps.iter().enumerate() {
        if step.label.as_ref().is_some_and(|label| {
            label.trim().is_empty()
                || label.chars().count() > 80
                || label.chars().any(char::is_control)
        }) {
            return Err(error(
                ErrorCode::InvalidInput,
                "步骤名称必须为1到80个无控制字符的文字",
            ));
        }
        validation::identifier(&step.id)?;
        if previous.contains_key(step.id.as_str()) {
            return Err(error(ErrorCode::InvalidInput, "自动调试步骤标识不能重复"));
        }
        if step.tool.command().is_action() && !input.confirmed {
            return Err(error(
                ErrorCode::InvalidInput,
                "包含界面动作、数据写入或试调用的步骤必须确认本次运行",
            ));
        }
        let mut parameters = step.parameters.clone();
        let mut target_bound = false;
        if let Some(binding) = &step.bind {
            if let Some(id) = &binding.target_from_step {
                if step.tool != AutomationStepTool::UiAction
                    || !previous
                        .get(id.as_str())
                        .is_some_and(|step| step.tool == AutomationStepTool::UiQuery)
                {
                    return Err(error(
                        ErrorCode::InvalidInput,
                        "界面目标只能绑定到先前的界面查询步骤",
                    ));
                }
                let action = parameters
                    .get_mut("action")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| {
                        error(ErrorCode::InvalidInput, "绑定目标需要明确的界面动作对象")
                    })?;
                if action.contains_key("target") {
                    return Err(error(
                        ErrorCode::InvalidInput,
                        "绑定目标不能同时提供静态目标引用",
                    ));
                }
                target_bound = true;
            }
            if let Some(id) = &binding.revision_from_step {
                if step.tool != AutomationStepTool::DataWrite
                    || !previous.get(id.as_str()).is_some_and(|before| {
                        before.tool == AutomationStepTool::DataRead
                            && before.parameters.get("source_id")
                                == step.parameters.get("source_id")
                    })
                {
                    return Err(error(
                        ErrorCode::InvalidInput,
                        "写入修订只能绑定到先前的数据读取步骤",
                    ));
                }
                let fields = parameters
                    .as_object_mut()
                    .ok_or_else(|| error(ErrorCode::InvalidInput, "数据写入参数必须是对象"))?;
                if fields.contains_key("expected_revision") {
                    return Err(error(
                        ErrorCode::InvalidInput,
                        "绑定修订不能同时提供静态修订",
                    ));
                }
                // 只为复用静态输入验证补入占位，不修改将被传输的原始步骤。
                fields.insert(
                    "expected_revision".into(),
                    Value::String("bound-revision".into()),
                );
            }
            if binding.target_from_step.is_none() && binding.revision_from_step.is_none() {
                return Err(error(ErrorCode::InvalidInput, "步骤绑定不能为空"));
            }
        }
        if step.tool == AutomationStepTool::UiAction
            && parameters.pointer("/action/type").and_then(Value::as_str) == Some("pick")
        {
            return Err(ui_contract::invalid(
                &format!("parameters.steps.{index}.parameters.action.type"),
                "自动调试不等待人工拾取；请使用 ui_query 后绑定唯一节点",
                json!({"tool":"ui_action","parameters":{"action":{"type":"click","confirmed":true}},"bind":{"target_from_step":"query"}}),
            ));
        }
        let checked = if target_bound {
            validation::payload(&parameters)?;
            ui_contract::validate_bound_action(&parameters)
        } else {
            validate(step.tool.command(), &parameters)
        };
        checked.map_err(|mut failure| {
            failure.message = failure.message.replace(
                "\"path\":\"parameters",
                &format!("\"path\":\"parameters.steps.{index}.parameters"),
            );
            failure
        })?;
        previous.insert(step.id.as_str(), step);
    }
    ui_contract::validate_automation_shape(parameters)
}
