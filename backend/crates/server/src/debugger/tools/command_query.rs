//! 历史回执查询只核对原会话归属，不重新准入、选择或派发命令。

use super::{decode, encode, error};
use crate::ApiError;
use apk_application::debugger::DebuggerService;
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct CommandQuery {
    session_id: String,
    command_id: String,
}

pub(super) fn query(debugger: &DebuggerService, input: Value) -> Result<Value, ApiError> {
    let input: CommandQuery = decode(input)?;
    let result = debugger.command_result(&input.command_id).map_err(error)?;
    if result.session_id != input.session_id {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "debugger_not_found",
            "此会话没有对应的命令回执",
        ));
    }
    encode(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use apk_application::debugger::*;
    use serde_json::json;

    #[tokio::test]
    async fn debugger_command_query_checks_session_and_preserves_history_without_replay() {
        let service = DebuggerService::new();
        let instance = service
            .register_instance(BridgeRegistration {
                plugins: vec![BridgePlugin {
                    plugin_id: "example".into(),
                    generation: Some("g1".into()),
                    version: None,
                }],
            })
            .unwrap();
        let target = DebugTarget {
            target_kind: TargetKind::Browser,
            instance_id: Some(instance.instance_id.clone()),
            plugin_id: "example".into(),
            generation: Some("g1".into()),
            version: None,
        };
        let session = service
            .open_session(SessionRequest {
                target: target.clone(),
            })
            .unwrap();
        let other = service.open_session(SessionRequest { target }).unwrap();
        let command = service.enqueue(DebugCommandRequest { session_id:session.session_id.clone(),
            tool:DebugTool::DataWrite, parameters:json!({"source_id":"aliases","expected_revision":"r1","value":{},"confirmed":true}) }).unwrap();
        let poll = BridgePoll {
            instance_id: instance.instance_id.clone(),
            limit: 4,
        };
        assert_eq!(service.poll(poll.clone()).await.unwrap().commands.len(), 1);
        service.close_session(&session.session_id).unwrap();
        let input = json!({"session_id":session.session_id,"command_id":command.command_id});
        let result =
            query(&service, input.clone()).unwrap_or_else(|_| panic!("所属历史回执应可查询"));
        assert_eq!(result["state"], "cancelled_unconfirmed");
        assert_eq!(
            query(&service, input).unwrap_or_else(|_| panic!("查询不能改变历史回执")),
            result
        );
        assert!(
            query(
                &service,
                json!({"session_id":other.session_id,"command_id":command.command_id})
            )
            .is_err()
        );
        assert!(
            query(
                &service,
                json!({"session_id":session.session_id,"command_id":"missing"})
            )
            .is_err()
        );
        service.close_session(&other.session_id).unwrap();
        assert!(service.poll(poll).await.unwrap().commands.is_empty());
    }
}
