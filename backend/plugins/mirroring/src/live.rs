//! scrcpy-server 三路直播；保持原期限、有限重连与独占资源确认。
mod control;
mod device;
mod device_messages;
mod lifecycle;
mod model;
mod owned_control;
pub(crate) mod ownership;
mod pressed_inputs;
mod webrtc;
mod wire;
use apk_plugin_sdk::session::SessionOpen;
use deviceforge_plugin_runtime::{
    Execution, InvocationContext,
    session::{SessionInput, SessionOutput},
};
use std::future::Future;

pub async fn execute(
    open: SessionOpen,
    context: InvocationContext,
    input: SessionInput,
    output: SessionOutput,
) -> Execution {
    let webrtc = open.operation == "open_webrtc";
    let client_id = open.session_id.clone();
    let master = open.client.as_ref().is_some_and(|client| client.is_local);
    let mut recovery_unconfirmed = false;
    let result = async {
        context.check().map_err(|error| error.to_string())?;
        validate_access(&open)?;
        let parameters: model::Open =
            serde_json::from_value(open.input).map_err(|_| "直播打开输入无效")?;
        parameters.validate()?;
        if !webrtc && parameters.control {
            return Err("设备控制请使用支持控制权移交的 WebRTC 投屏".into());
        }
        let config = checked(&context, crate::config::read()).await?;
        if config.live.is_none() {
            return Err("部署者未配置直播服务".into());
        }
        if let Err(error) =
            crate::recovery::before_session(&parameters.device_id, &config, &context).await
        {
            match error {
                crate::recovery::AdmissionError::Busy(message) => return Err(message),
                crate::recovery::AdmissionError::Unconfirmed(message) => {
                    recovery_unconfirmed = true;
                    return Err(format!("投屏资源自动核对未通过：{message}"));
                }
            }
        }
        Ok((parameters, config))
    }
    .await;
    match result {
        Ok((parameters, config)) if webrtc => {
            webrtc::run(
                parameters, config, context, input, output, client_id, master,
            )
            .await
        }
        Ok((parameters, config)) => {
            lifecycle::run(parameters, config, context, input, output).await
        }
        Err(error) => open_failure(error, recovery_unconfirmed),
    }
}

fn open_failure(error: String, recovery_unconfirmed: bool) -> Execution {
    Execution {
        outcome: Err(error),
        cleanup: if recovery_unconfirmed {
            apk_plugin_sdk::cooperative::CleanupOutcome::Failed
        } else {
            apk_plugin_sdk::cooperative::CleanupOutcome::Complete
        },
    }
}
fn validate_access(open: &SessionOpen) -> Result<(), String> {
    // 宿主可为共用录像权限提供空输入和输出目录；直播只传媒体，不使用产物目录。
    if !matches!(open.operation.as_str(), "open" | "open_webrtc")
        || open
            .artifacts
            .as_ref()
            .is_some_and(|artifacts| !artifacts.inputs.is_empty())
    {
        return Err("直播打开操作或产物输入无效".into());
    }
    Ok(())
}

pub(crate) async fn checked<T>(
    context: &InvocationContext,
    work: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    context.check().map_err(|error| error.to_string())?;
    let cancel = context.cancellation();
    tokio::select! {
        biased;
        _=tokio::time::sleep_until(context.deadline().into())=>Err("直播业务期限已到期".into()),
        _=cancel.cancelled()=>Err("直播已取消".into()),
        result=work=>result,
    }
}

#[cfg(test)]
mod access_tests {
    use super::validate_access;
    use apk_plugin_sdk::{ArtifactContext, ArtifactInput, session::SessionOpen};
    use serde_json::json;

    #[test]
    fn only_unconfirmed_recovery_marks_host_resource_risk() {
        use apk_plugin_sdk::cooperative::CleanupOutcome;
        assert_eq!(
            super::open_failure("台账仍有未确认资源".into(), true).cleanup,
            CleanupOutcome::Failed
        );
        assert_eq!(
            super::open_failure("直播打开输入无效".into(), false).cleanup,
            CleanupOutcome::Complete
        );
        assert_eq!(
            super::open_failure("设备正在并发核对".into(), false).cleanup,
            CleanupOutcome::Complete
        );
    }

    #[test]
    fn shared_recording_permission_is_not_a_live_input() {
        let mut open = SessionOpen::new("stream", "open", json!({}));
        assert!(validate_access(&open).is_ok());
        open.artifacts = Some(ArtifactContext {
            inputs: vec![],
            output_directory: None,
        });
        assert!(validate_access(&open).is_ok());
        open.artifacts.as_mut().unwrap().output_directory = Some("unused-output".into());
        assert!(validate_access(&open).is_ok());
    }

    #[test]
    fn live_rejects_artifact_inputs_and_unregistered_operation() {
        let mut open = SessionOpen::new("stream", "open", json!({}));
        open.artifacts = Some(ArtifactContext {
            inputs: vec![ArtifactInput {
                field: "artifact_id".into(),
                artifact_id: "input".into(),
                filename: "unused.bin".into(),
                size: 0,
                sha256: "0".repeat(64),
                path: "unused-input".into(),
            }],
            output_directory: None,
        });
        assert!(validate_access(&open).is_err());
        open.artifacts = None;
        open.operation = "record".into();
        assert!(validate_access(&open).is_err());
    }
}
