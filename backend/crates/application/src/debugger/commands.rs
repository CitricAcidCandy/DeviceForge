//! 数据和自动调试只定义传输与准入；实际读写和逐步执行仍由选定浏览器处理。

use super::{
    DebugTool, ErrorCode, Result,
    validation::{self, error},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

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

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AutomationStep {
    pub id: String,
    pub tool: AutomationStepTool,
    pub parameters: Value,
    #[serde(default)]
    pub bind: Option<AutomationBinding>,
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

fn stop_on_failure() -> bool {
    true
}

fn decode<T: serde::de::DeserializeOwned>(parameters: &Value) -> Result<T> {
    serde_json::from_value(parameters.clone())
        .map_err(|_| error(ErrorCode::InvalidInput, "数据或自动调试参数不符合工具模式"))
}

pub(super) fn validate(tool: DebugTool, parameters: &Value) -> Result<()> {
    match tool {
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
        _ => validation::payload(parameters),
    }
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
    let input: AutomationInput = decode(parameters)?;
    if input.steps.is_empty() || input.steps.len() > 32 {
        return Err(error(
            ErrorCode::InvalidInput,
            "自动调试必须包含1到32个步骤",
        ));
    }
    let mut previous = BTreeMap::<&str, &AutomationStep>::new();
    for step in &input.steps {
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
        validate(step.tool.command(), &parameters)?;
        previous.insert(step.id.as_str(), step);
    }
    Ok(())
}
