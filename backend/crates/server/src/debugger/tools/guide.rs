//! 只读调试操作指南；案例使用公开占位值，不读取宿主文件、创建会话或扩大验证范围。

use super::{ApiError, decode, encode};
use apk_application::debugger::{
    DebugTool,
    ui_contract::{UI_CONTRACT_REVISION, example},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Default, Clone, Copy, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum GuideTopic {
    #[default]
    Quickstart,
    Ui,
    Automation,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct GuideInput {
    #[serde(default)]
    pub topic: GuideTopic,
}

#[derive(Serialize, JsonSchema)]
pub(crate) struct GuideExample {
    pub tool: String,
    pub input: Value,
}

#[derive(Serialize, JsonSchema)]
pub(crate) struct GuideOutput {
    pub revision: String,
    pub topic: GuideTopic,
    pub content: String,
    pub examples: Vec<GuideExample>,
}

fn call(tool: &str, input: Value) -> GuideExample {
    GuideExample {
        tool: format!("deviceforge.debug_{tool}"),
        input,
    }
}

fn command(tool: &str, parameters: Value) -> GuideExample {
    call(
        tool,
        json!({"session_id":"当前会话标识","parameters":parameters}),
    )
}

pub(super) fn read(input: Value) -> Result<Value, ApiError> {
    if !input.is_object() {
        return Err(ApiError::new(
            axum::http::StatusCode::BAD_REQUEST,
            "debugger_invalid_input",
            "指南参数必须是包含可选 topic 的对象；topic 支持 quickstart、ui、automation",
        ));
    }
    let input: GuideInput = decode(input)?;
    let (content, examples) = match input.topic {
        GuideTopic::Quickstart => (
            QUICKSTART,
            vec![
                call("targets", json!({})),
                call(
                    "session",
                    json!({"action":"open","target":{
                        "target_kind":"browser","instance_id":"00000000-0000-4000-8000-000000000000",
                        "plugin_id":"example.plugin","generation":"当前目录中的代次"
                    }}),
                ),
                command("inspect", json!({})),
                command("ui_tree", example(DebugTool::UiTree)),
                command("ui_query", example(DebugTool::UiQuery)),
                call(
                    "command",
                    json!({"session_id":"当前会话标识","command_id":"原命令标识"}),
                ),
                call(
                    "session",
                    json!({"action":"close","session_id":"当前会话标识"}),
                ),
            ],
        ),
        GuideTopic::Ui => (
            UI,
            vec![
                command("ui_tree", json!({"root_id":"root-1","limit":50})),
                command(
                    "ui_tree",
                    json!({"root_id":"root-1","snapshot_id":"snapshot-1","offset":50,"limit":50}),
                ),
                command("ui_query", example(DebugTool::UiQuery)),
                command("ui_diff", example(DebugTool::UiDiff)),
                command("ui_assert", example(DebugTool::UiAssert)),
                command(
                    "ui_assert",
                    json!({"root_id":"root-1","assertion":{
                        "query":{"role":"combobox","name":"模式"},"condition":"selected_equals","expected":["mirror"]
                    }}),
                ),
                command("ui_action", example(DebugTool::UiAction)),
                command(
                    "ui_action",
                    json!({"action":{"type":"navigate","path":"/devices","confirmed":true}}),
                ),
                command(
                    "ui_action",
                    json!({"root_id":"root-1","action":{"type":"pick"}}),
                ),
                command(
                    "ui_action",
                    json!({"root_id":"root-1","action":{
                "type":"click","target":{"id":"node-2","generation":1,"revision":1},
                "confirmed":true,"allowUnknownSideEffects":true
            },"expect":{"kind":"data","source_id":"从数据目录取得的状态源标识",
                "checks":[{"pointer":"/connected","equals":true}],"timeout_ms":3000}}),
                ),
            ],
        ),
        GuideTopic::Automation => (
            AUTOMATION,
            vec![
                command("automation_run", four_steps()),
                command(
                    "automation_run",
                    json!({"confirmed":true,"stop_on_failure":true,"steps":[
                        {"id":"read","tool":"data_read","parameters":{"source_id":"从数据目录取得的标识"}},
                        {"id":"write","tool":"data_write","parameters":{"source_id":"从数据目录取得的标识","value":{"name":"示例"},"confirmed":true},"bind":{"revision_from_step":"read"}}
                    ]}),
                ),
            ],
        ),
    };
    encode(GuideOutput {
        revision: UI_CONTRACT_REVISION.into(),
        topic: input.topic,
        content: content.into(),
        examples,
    })
}

fn four_steps() -> Value {
    json!({"confirmed":true,"stop_on_failure":true,"steps":[
        {"id":"address","tool":"ui_query","parameters":{"root_id":"root-1","query":{"role":"textbox","name":"设备地址","limit":2}}},
        {"id":"fill","tool":"ui_action","parameters":{"root_id":"root-1","action":{"type":"fill","value":"127.0.0.1:5555","confirmed":true,"allowUnknownSideEffects":true},
            "expect":{"kind":"ui","assertion":{"query":{"role":"textbox","name":"设备地址"},"condition":"value_equals","expected":"127.0.0.1:5555"}}},"bind":{"target_from_step":"address"}},
        {"id":"button","tool":"ui_query","parameters":{"root_id":"root-1","query":{"role":"button","name":"连接","limit":2}}},
        {"id":"connect","tool":"ui_action","parameters":{"root_id":"root-1","action":{"type":"click","confirmed":true,"allowUnknownSideEffects":true},
            "expect":{"kind":"data","source_id":"从数据目录取得的状态源标识","checks":[{"pointer":"/connected","equals":true}],"timeout_ms":3000}},"bind":{"target_from_step":"button"}}
    ]})
}

const QUICKSTART: &str = "先调用 debug_targets，再用返回的实例、插件和代次打开明确会话。复用一次 inspect 获得的挂载根与能力；根目录和节点不是插件扩展点。案例中的实例、会话、root_id、节点、代次和数据源均须替换为实际返回值。工具参数格式确认一次后复用；四步交互优先使用 automation 的一次调用。旧节点修订失效时只重查受影响目标。未知回执按原 command_id 查询，不重新派发。结束本次调试后关闭自有会话。";

const UI: &str = "顶层只有 session_id 和 parameters。挂载根放 parameters.root_id，动作放 parameters.action；type、target、confirmed、allowUnknownSideEffects、value、values、assertion、timeoutMs、path 都位于 action 内，expect 则与 action 并列。target 是含 id、generation、revision 的完整节点引用。click/fill/select/scroll/navigate 必须 confirmed=true；未知副作用仍需 allowUnknownSideEffects=true，不能替代产品原有禁用、校验和确认。pick 仅拦截一次人工点击。wait 的 timeoutMs 为 0..10000，原默认1000毫秒。expect.kind=ui 使用明确断言；kind=data 只读取已登记数据源，checks 为1..16条明确 JSON Pointer 等值检查，无脚本求值。expect.timeout_ms 默认3000、上限10000，并消耗原命令剩余预算。value_equals 的 expected 为字符串，selected_equals 为字符串数组，只比较普通非敏感控件，不返回原始值。dispatched 只说明事件已发出；verification 说明控件、界面或业务检查范围，不能把界面变化写成投屏成功。没有状态源时应报告能力缺口和结果未知，停止扩大日志、视觉或设备排查。";

const AUTOMATION: &str = "debug_automation_run 一次接收1..32步，所有步骤共享原30秒总预算，第一步前校验整份计划。每步包含 id、tool、parameters，可选 label 和 bind。tool 不带 deviceforge.debug_ 前缀。参数与普通工具一致。绑定节点时使用 bind.target_from_step 引用先前唯一节点的 ui_query，并省略 parameters.action.target；固定 target 与绑定互斥。绑定修订只引用同数据源先前 data_read，省略 expected_revision。计划 confirmed 不替代每个变更动作的 confirmed 或未知副作用授权。不能嵌套自动化、重载或等待人工 pick。结果中的步骤 succeeded 表示调用返回，业务成功仍需对应 verification；无关节点断言不能确认另一个动作。四步示例复用根和格式，每个新目标只查一次；需预先确认示例数据源实际存在并有 connected 字段，否则移除该业务检查、明确报告无法确认，不能虚构状态源或自动重试点击。";
