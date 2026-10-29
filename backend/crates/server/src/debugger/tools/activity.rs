//! 跨会话观察只投影同一明确目标的公开命令事实，不改变原回执所属会话规则。

use super::{decode, encode, error};
use crate::ApiError;
use apk_application::debugger::{ActivityQuery, DebuggerService};
use serde_json::Value;

pub(super) fn query(debugger: &DebuggerService, input: Value) -> Result<Value, ApiError> {
    let input: ActivityQuery = decode(input)?;
    encode(debugger.activity(input).map_err(error)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use apk_application::debugger::*;
    use serde_json::json;

    #[tokio::test]
    async fn debugger_activity_cross_session_is_read_only_without_relaxing_command_ownership() {
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
            instance_id: Some(instance.instance_id),
            plugin_id: "example".into(),
            generation: Some("g1".into()),
            version: None,
        };
        let agent = service
            .open_session(SessionRequest {
                target: target.clone(),
            })
            .unwrap();
        let observer = service.open_session(SessionRequest { target }).unwrap();
        let receipt = service
            .enqueue(DebugCommandRequest {
                session_id: agent.session_id.clone(),
                tool: DebugTool::Inspect,
                parameters: json!({}),
            })
            .unwrap();
        let page = query(&service, json!({"session_id":observer.session_id}))
            .unwrap_or_else(|_| panic!("同目标活动查询应成功"));
        assert_eq!(page["items"][0]["command_id"], receipt.command_id);
        assert_eq!(page["items"][0]["response"], Value::Null);
        assert!(page["items"][0].get("session_id").is_none());
        assert!(
            super::super::command_query::query(
                &service,
                json!({"session_id":observer.session_id,"command_id":receipt.command_id})
            )
            .is_err()
        );
        assert_eq!(
            service.command_result(&receipt.command_id).unwrap().state,
            CommandState::Queued
        );
        for input in [
            json!({"session_id":observer.session_id,"parameters":{}}),
            json!({"session_id":observer.session_id,"limit":51}),
            json!({"session_id":observer.session_id,"before":0}),
        ] {
            assert!(query(&service, input).is_err());
        }
    }
}
