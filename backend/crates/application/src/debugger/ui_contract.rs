//! UI 调试的公开传输契约与纯输入校验；不观察 DOM、不派发动作、不读取业务数据。

use super::{DebugTool, DebuggerError, ErrorCode, Result, validation::error};
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::OnceLock};

pub const UI_CONTRACT_REVISION: &str = "2026-11-03.1";

/// 沿用浏览器的文本限制；不套用插件标识的命名或长度规则。
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(transparent)]
pub struct UiText(#[schemars(length(min = 1, max = 256), regex(pattern = "\\S"))] pub String);

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UiNodeRef {
    pub id: UiText,
    #[schemars(range(max = 9_007_199_254_740_991_u64))]
    pub generation: u64,
    #[schemars(range(max = 9_007_199_254_740_991_u64))]
    pub revision: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UiEvidenceState {
    Yes,
    No,
    Unknown,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TreeQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "UiText")]
    pub id: Option<UiText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "UiText")]
    pub role: Option<UiText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "UiText")]
    pub name: Option<UiText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "UiText")]
    pub surface_id: Option<UiText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "UiText")]
    pub descendant_of: Option<UiText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "UiEvidenceState")]
    pub hidden: Option<UiEvidenceState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "UiEvidenceState")]
    pub disabled: Option<UiEvidenceState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u16", range(min = 1, max = 500))]
    pub limit: Option<u16>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "condition", rename_all = "snake_case", deny_unknown_fields)]
pub enum TreeAssertion {
    Exists {
        query: TreeQuery,
    },
    Absent {
        query: TreeQuery,
    },
    Count {
        query: TreeQuery,
        #[schemars(range(max = 500))]
        expected: u16,
    },
    Enabled {
        query: TreeQuery,
    },
    Visible {
        query: TreeQuery,
    },
    Valid {
        query: TreeQuery,
    },
    InViewport {
        query: TreeQuery,
    },
    WithinRoot {
        query: TreeQuery,
    },
    Unclipped {
        query: TreeQuery,
    },
    NonzeroSize {
        query: TreeQuery,
    },
    /// 只检查普通非敏感控件，不开放整棵树中的原始值。
    ValueEquals {
        query: TreeQuery,
        #[schemars(length(max = 16384))]
        expected: String,
    },
    SelectedEquals {
        query: TreeQuery,
        #[schemars(with = "Vec<UiAssertionSelectionText>", length(max = 100), extend("uniqueItems" = true))]
        expected: Vec<String>,
    },
}

/// 断言允许普通选项的空值；每项长度与浏览器解析器保持一致。
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(transparent)]
pub struct UiAssertionSelectionText(#[schemars(length(max = 1024))] pub String);

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(extend("allOf" = [{"if":{"properties":{"offset":{"minimum":1}},"required":["offset"]},"then":{"required":["snapshot_id"]}}]))]
pub struct UiSnapshotInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "UiText")]
    pub root_id: Option<UiText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "UiText")]
    pub snapshot_id: Option<UiText>,
    #[serde(default)]
    #[schemars(range(max = 5000))]
    pub offset: u16,
    #[serde(default = "default_page_limit")]
    #[schemars(range(min = 1, max = 500))]
    pub limit: u16,
}

fn default_page_limit() -> u16 {
    500
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UiOverviewView {
    Overview,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UiOverviewInput {
    pub view: UiOverviewView,
    #[serde(default)]
    #[schemars(range(max = 10000))]
    pub offset: u16,
    #[serde(default = "default_page_limit")]
    #[schemars(range(min = 1, max = 500))]
    pub limit: u16,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(untagged)]
pub enum UiTreeInput {
    Overview(UiOverviewInput),
    Snapshot(UiSnapshotInput),
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UiQueryInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "UiText")]
    pub root_id: Option<UiText>,
    /// 保留原来省略查询对象的全节点查询输入。
    #[serde(default)]
    pub query: TreeQuery,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UiDiffInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "UiText")]
    pub root_id: Option<UiText>,
    pub before_id: UiText,
    pub after_id: UiText,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UiAssertInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "UiText")]
    pub root_id: Option<UiText>,
    pub assertion: TreeAssertion,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(extend("allOf" = [{"if":{"properties":{"action":{"properties":{"type":{"const":"navigate"}},"required":["type"]}},"required":["action"]},"then":{"not":{"required":["root_id"]}}}]))]
pub struct UiActionInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "UiText")]
    pub root_id: Option<UiText>,
    pub action: UiAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "UiActionExpectation")]
    pub expect: Option<UiActionExpectation>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(transparent)]
pub struct UiSelectionText(
    #[schemars(length(min = 1, max = 1024), regex(pattern = "\\S"))] pub String,
);

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum UiAction {
    Highlight {
        target: UiNodeRef,
        #[serde(default)]
        confirmed: bool,
        #[serde(default)]
        allow_unknown_side_effects: bool,
    },
    Click {
        target: UiNodeRef,
        #[schemars(extend("const" = true))]
        confirmed: bool,
        #[serde(default)]
        allow_unknown_side_effects: bool,
    },
    Scroll {
        target: UiNodeRef,
        #[schemars(extend("const" = true))]
        confirmed: bool,
        #[serde(default)]
        allow_unknown_side_effects: bool,
    },
    Fill {
        target: UiNodeRef,
        #[schemars(length(max = 16384))]
        value: String,
        #[schemars(extend("const" = true))]
        confirmed: bool,
        #[serde(default)]
        allow_unknown_side_effects: bool,
    },
    Select {
        target: UiNodeRef,
        #[schemars(length(max = 100))]
        values: Vec<UiSelectionText>,
        #[schemars(extend("const" = true))]
        confirmed: bool,
        #[serde(default)]
        allow_unknown_side_effects: bool,
    },
    Wait {
        assertion: TreeAssertion,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(with = "u32", range(max = 10000))]
        timeout_ms: Option<u32>,
    },
    Navigate {
        path: UiText,
        #[schemars(extend("const" = true))]
        confirmed: bool,
    },
    /// 拾取拦截一次人工点击，不执行业务动作；不能进入无人值守自动化。
    Pick {},
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct UiDataCheck {
    /// RFC 6901 的明确字段指针，不接受整份文档、脚本或表达式。
    #[schemars(length(min = 1, max = 1024), regex(pattern = "^/([^~]|~[01])*$"))]
    pub pointer: String,
    pub equals: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum UiActionExpectation {
    Ui {
        assertion: TreeAssertion,
        /// 等待包含在原命令或自动化剩余期限内，不能续期。
        #[serde(default = "default_expect_timeout")]
        #[schemars(range(max = 10000))]
        timeout_ms: u32,
    },
    Data {
        #[schemars(length(min = 1, max = 128), regex(pattern = "\\S"))]
        source_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        query: Option<Value>,
        #[schemars(length(min = 1, max = 16))]
        checks: Vec<UiDataCheck>,
        #[serde(default = "default_expect_timeout")]
        #[schemars(range(max = 10000))]
        timeout_ms: u32,
    },
}

fn default_expect_timeout() -> u32 {
    3000
}

/// 保持普通错误封套不变，只在调试错误的中文说明后附带不含原输入的结构化提示。
#[derive(Debug, Serialize, JsonSchema)]
pub struct UiValidationDetails {
    pub path: String,
    pub expected: String,
    pub example: Value,
}

pub(super) fn invalid(path: &str, expected: &str, example: Value) -> DebuggerError {
    let details = UiValidationDetails {
        path: path.into(),
        expected: expected.into(),
        example,
    };
    error(
        ErrorCode::InvalidInput,
        &format!(
            "调试参数不符合当前工具模式；details={}",
            serde_json::to_string(&details).unwrap_or_else(|_| "{}".into())
        ),
    )
}

/// 固定示例只含公开占位值；校验失败不得把调用者输入拼入错误或日志。
pub fn example(tool: DebugTool) -> Value {
    match tool {
        DebugTool::UiTree => json!({"view":"overview","offset":0,"limit":50}),
        DebugTool::UiQuery => {
            json!({"root_id":"root-1","query":{"role":"textbox","name":"设备地址","limit":1}})
        }
        DebugTool::UiDiff => {
            json!({"root_id":"root-1","before_id":"snapshot-1","after_id":"snapshot-2"})
        }
        DebugTool::UiAssert => {
            json!({"root_id":"root-1","assertion":{"query":{"role":"textbox","name":"设备地址"},"condition":"value_equals","expected":"127.0.0.1:5555"}})
        }
        _ => {
            json!({"root_id":"root-1","action":{"type":"fill","target":{"id":"node-1","generation":1,"revision":1},"value":"127.0.0.1:5555","confirmed":true,"allowUnknownSideEffects":true},"expect":{"kind":"ui","assertion":{"query":{"role":"textbox","name":"设备地址"},"condition":"value_equals","expected":"127.0.0.1:5555"},"timeout_ms":3000}})
        }
    }
}

struct CheckedSchema {
    schema: Value,
    validator: jsonschema::Validator,
}

impl CheckedSchema {
    fn new(schema: Value) -> std::result::Result<Self, ()> {
        let validator = jsonschema::validator_for(&schema).map_err(|_| ())?;
        Ok(Self { schema, validator })
    }

    fn check(&self, input: &Value, prefix: &str, example: Value) -> Result<()> {
        let Some(failure) = self.validator.iter_errors(input).next() else {
            return Ok(());
        };
        let pointer = failure.instance_path.to_string();
        let schema_pointer = failure.schema_path.to_string();
        let mut path = format!("{prefix}{}", pointer.replace('/', "."));
        let constraint = self.schema.pointer(&schema_pointer);
        let expected = if schema_pointer.ends_with("/required") {
            let missing = constraint.and_then(Value::as_array).and_then(|required| {
                required.iter().filter_map(Value::as_str).find(|key| {
                    input
                        .pointer(&pointer)
                        .and_then(|item| item.get(*key))
                        .is_none()
                })
            });
            if let Some(missing) = missing {
                path.push('.');
                path.push_str(missing);
            }
            "补齐本动作在公开模式中声明的必填字段".into()
        } else if schema_pointer.ends_with("/additionalProperties") {
            "仅使用公开字段，并按示例放在 parameters、action 或 expect 的正确层级".into()
        } else {
            let rule = schema_pointer.rsplit('/').next().unwrap_or("类型");
            // 联合模式可能包含整份动作目录，错误提示不能再复制一遍完整目录。
            let concise = constraint
                .filter(|value| {
                    !value.is_object()
                        && value.as_array().is_none_or(|values| {
                            values.len() <= 16
                                && values
                                    .iter()
                                    .all(|item| !item.is_object() && !item.is_array())
                        })
                })
                .map(Value::to_string)
                .filter(|text| text.len() <= 256);
            concise.map_or_else(
                || format!("符合公开模式的 {rule} 约束，请按修正示例选择对应分支"),
                |value| format!("符合公开模式约束 {rule}={value}"),
            )
        };
        Err(invalid(&path, &expected, example))
    }
}

fn schema<T: JsonSchema>() -> Value {
    let mut settings = schemars::generate::SchemaSettings::draft2020_12();
    settings.inline_subschemas = true;
    serde_json::to_value(settings.into_generator().into_root_schema_for::<T>())
        .expect("公开 UI 契约必须可编码")
}

struct UiSchemas {
    tools: BTreeMap<&'static str, CheckedSchema>,
    actions: BTreeMap<String, CheckedSchema>,
}

fn tool_name(tool: DebugTool) -> Option<&'static str> {
    match tool {
        DebugTool::UiTree => Some("ui_tree"),
        DebugTool::UiQuery => Some("ui_query"),
        DebugTool::UiDiff => Some("ui_diff"),
        DebugTool::UiAssert => Some("ui_assert"),
        DebugTool::UiAction => Some("ui_action"),
        _ => None,
    }
}

impl UiSchemas {
    fn new() -> std::result::Result<Self, ()> {
        let tools = [
            ("ui_tree", schema::<UiTreeInput>()),
            ("ui_query", schema::<UiQueryInput>()),
            ("ui_diff", schema::<UiDiffInput>()),
            ("ui_assert", schema::<UiAssertInput>()),
            ("ui_action", schema::<UiActionInput>()),
        ]
        .into_iter()
        .map(|(name, schema)| Ok((name, CheckedSchema::new(schema)?)))
        .collect::<std::result::Result<_, ()>>()?;
        let mut actions = BTreeMap::new();
        let action_schema = schema::<UiAction>();
        for branch in alternatives(&action_schema) {
            if let Some(kind) = branch["properties"]["type"]["const"].as_str() {
                actions.insert(kind.into(), CheckedSchema::new(branch.clone())?);
            }
        }
        Ok(Self { tools, actions })
    }
}

fn alternatives(schema: &Value) -> impl Iterator<Item = &Value> {
    schema
        .get("oneOf")
        .or_else(|| schema.get("anyOf"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

pub(super) fn validate(tool: DebugTool, parameters: &Value) -> Result<()> {
    static SCHEMAS: OnceLock<std::result::Result<UiSchemas, ()>> = OnceLock::new();
    let schemas = SCHEMAS
        .get_or_init(UiSchemas::new)
        .as_ref()
        .map_err(|_| error(ErrorCode::Internal, "UI 调试契约不可用；普通业务不受影响"))?;
    if tool == DebugTool::UiAction {
        if let Some(action) = parameters.get("action") {
            if action.is_object() && !action.get("type").is_some_and(Value::is_string) {
                return Err(invalid(
                    "parameters.action.type",
                    "必须提供动作类型，例如 fill、select 或 click",
                    example(tool),
                ));
            }
            if let Some(kind) = action.get("type").and_then(Value::as_str) {
                let checked = schemas.actions.get(kind).ok_or_else(|| {
                    invalid(
                        "parameters.action.type",
                        "支持 highlight、click、scroll、fill、select、wait、navigate、pick",
                        example(tool),
                    )
                })?;
                checked.check(action, "parameters.action", example(tool))?;
            }
        }
    }
    if let Some(checked) = tool_name(tool).and_then(|name| schemas.tools.get(name)) {
        checked.check(parameters, "parameters", example(tool))?;
    }
    Ok(())
}

/// 自动化仍传输原始步骤；这里只从相同动作模式派生绑定版，不伪造节点给浏览器。
pub(super) fn automation_action_schema(generator: &mut SchemaGenerator, bound: bool) -> Schema {
    let mut parameters = UiActionInput::json_schema(generator).to_value();
    let actions = UiAction::json_schema(generator).to_value();
    let branches: Vec<_> = alternatives(&actions)
        .filter_map(|original| {
            let kind = original["properties"]["type"]["const"].as_str()?;
            if kind == "pick" || (bound && matches!(kind, "wait" | "navigate")) {
                return None;
            }
            let mut branch = original.clone();
            if bound {
                branch["properties"].as_object_mut()?.remove("target");
                branch["required"]
                    .as_array_mut()?
                    .retain(|field| field != "target");
            }
            Some(branch)
        })
        .collect();
    parameters["properties"]["action"] = json!({"oneOf":branches});
    serde_json::from_value(parameters).expect("自动化动作模式必须为对象")
}

/// 绑定版只省略动作目标，其余字段和确认仍复用普通调用校验。
pub(super) fn validate_bound_action(parameters: &Value) -> Result<()> {
    let kind = parameters.pointer("/action/type").and_then(Value::as_str);
    if !matches!(
        kind,
        Some("highlight" | "click" | "scroll" | "fill" | "select")
    ) {
        return Err(invalid(
            "parameters.action.type",
            "节点绑定只支持需要节点目标的动作",
            example(DebugTool::UiAction),
        ));
    }
    if parameters.pointer("/action/target").is_some() {
        return Err(invalid(
            "parameters.action.target",
            "固定 target 与 bind.target_from_step 互斥；绑定时省略 target",
            json!({"action":{"type":"click","confirmed":true}}),
        ));
    }
    let mut resolved = parameters.clone();
    if let Some(action) = resolved.get_mut("action").and_then(Value::as_object_mut) {
        action.insert(
            "target".into(),
            json!({"id":"bound-target","generation":0,"revision":0}),
        );
    }
    validate(DebugTool::UiAction, &resolved)
}

/// 同一自动化 Schema 在首用时编译一次，之后不随每个请求重复生成或编译。
pub(super) fn validate_automation_shape(parameters: &Value) -> Result<()> {
    static SCHEMA: OnceLock<std::result::Result<CheckedSchema, ()>> = OnceLock::new();
    let checked = SCHEMA
        .get_or_init(|| CheckedSchema::new(schema::<super::AutomationInput>()))
        .as_ref()
        .map_err(|_| error(ErrorCode::Internal, "自动调试契约不可用；普通业务不受影响"))?;
    checked.check(parameters, "parameters", json!({"confirmed":false,"steps":[{"id":"overview","tool":"ui_tree","parameters":{"view":"overview"}}]}))
}
