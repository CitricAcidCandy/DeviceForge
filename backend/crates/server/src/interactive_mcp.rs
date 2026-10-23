use crate::interactive::*;
use apk_application::Application;
use apk_domain::{Error, Result, interactive::SessionDefinition};
use rmcp::model::Tool;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

pub(crate) fn session_tool(definition: SessionDefinition) -> Tool {
    Tool::new(
        definition.id,
        format!(
            "{}。打开持续会话并返回会话ID；使用会话输出、输入、EOF及释放工具继续交互。",
            definition.title
        ),
        definition
            .input_schema
            .as_object()
            .expect("注册会话模式为对象")
            .clone(),
    )
}

pub(crate) fn tools() -> Vec<Tool> {
    let empty = json!({"type":"object","additionalProperties":false});
    [
        (
            "deviceforge.list_session_definitions",
            "列出当前持续会话贡献和原预算",
            empty.clone(),
        ),
        (
            "deviceforge.list_sessions",
            "列出本次宿主运行中的保留会话",
            empty,
        ),
        (
            "deviceforge.get_session",
            "读取会话状态、业务结果和清理确认",
            schema::<SessionIdInput>(),
        ),
        (
            "deviceforge.session_output",
            "按排他游标读取原字节输出，每页最多100块",
            schema::<SessionOutputInput>(),
        ),
        (
            "deviceforge.session_input",
            "向已打开会话发送原字节；成功仅确认准入",
            schema::<SessionMcpBytesInput>(),
        ),
        (
            "deviceforge.session_eof",
            "有序关闭会话数据输入，保留取消通路",
            schema::<SessionIdInput>(),
        ),
        (
            "deviceforge.cancel_session",
            "撤销会话输入并请求停止，真实终态另行查询",
            schema::<SessionIdInput>(),
        ),
        (
            "deviceforge.release_session",
            "请求释放会话，清理确认后自动删除记录；失败记录保留",
            schema::<SessionIdInput>(),
        ),
        (
            "deviceforge.remove_session",
            "删除已结束会话的内存记录",
            schema::<SessionIdInput>(),
        ),
    ]
    .into_iter()
    .map(|(name, description, schema)| {
        Tool::new(
            name,
            description,
            schema.as_object().expect("会话工具模式为对象").clone(),
        )
    })
    .collect()
}

pub(crate) fn manages(name: &str) -> bool {
    matches!(
        name,
        "deviceforge.list_session_definitions"
            | "deviceforge.list_sessions"
            | "deviceforge.get_session"
            | "deviceforge.session_output"
            | "deviceforge.session_input"
            | "deviceforge.session_eof"
            | "deviceforge.cancel_session"
            | "deviceforge.release_session"
            | "deviceforge.remove_session"
    )
}

pub(crate) async fn invoke(
    app: &std::sync::Arc<Application>,
    name: &str,
    input: Value,
) -> Result<Value> {
    match name {
        "deviceforge.list_session_definitions" | "deviceforge.list_sessions" => {
            if input != json!({}) {
                return Err(Error::Invalid("会话列表不接收参数".into()));
            }
            if name.ends_with("list_sessions") {
                encode(app.session_records())
            } else {
                let (revision, sessions) = app.session_definitions();
                encode(SessionDefinitions { revision, sessions })
            }
        }
        "deviceforge.get_session" => {
            let request: SessionIdInput = decode(input)?;
            encode(app.session(&request.id)?)
        }
        "deviceforge.session_output" => {
            let request: SessionOutputInput = decode(input)?;
            encode(app.session_output(&request.id, request.after, request.limit)?)
        }
        "deviceforge.session_input" => {
            let request: SessionMcpBytesInput = decode(input)?;
            app.session_send(&request.id, &request.bytes).await?;
            encode(SessionReceipt {
                id: request.id,
                accepted: true,
            })
        }
        "deviceforge.session_eof" => {
            let request: SessionIdInput = decode(input)?;
            app.session_eof(&request.id).await?;
            encode(SessionReceipt {
                id: request.id,
                accepted: true,
            })
        }
        "deviceforge.cancel_session" => {
            let request: SessionIdInput = decode(input)?;
            encode(app.session_cancel(&request.id)?)
        }
        "deviceforge.release_session" => {
            let request: SessionIdInput = decode(input)?;
            encode(app.session_release(&request.id)?)
        }
        "deviceforge.remove_session" => {
            let request: SessionIdInput = decode(input)?;
            app.session_remove(&request.id)?;
            encode(SessionRemoved { id: request.id })
        }
        operation => encode(
            app.open_session_recovering_with_client(operation, input, None)
                .await?,
        ),
    }
}

fn schema<Type: schemars::JsonSchema>() -> Value {
    serde_json::to_value(schemars::schema_for!(Type)).expect("会话工具模式有效")
}

fn encode(value: impl Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|_| Error::Dependency("会话结果编码失败".into()))
}

fn decode<Type: DeserializeOwned>(input: Value) -> Result<Type> {
    serde_json::from_value(input).map_err(|_| Error::Invalid("会话工具参数无效".into()))
}
