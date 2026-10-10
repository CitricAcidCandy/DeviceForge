use super::input::ArtifactInput;
use crate::{Error, Result, config::Tool, session::Session};
use deviceforge_plugin_runtime::Output;
use serde_json::json;

pub(super) async fn run(session: &Session, _input: ArtifactInput) -> Result<Output> {
    let path = session.input.path.to_string_lossy().into_owned();
    let report = session
        .tool(
            Tool::Apksigner,
            vec![
                "verify".into(),
                "--verbose".into(),
                "--print-certs".into(),
                path.clone(),
            ],
        )
        .await?
        .replace(&path, &session.input.filename);
    let data = session
        .work(move |control| {
            Ok(deviceforge_android_package_core::android::parse_signature(
                &report, control,
            )?)
        })
        .await?;
    let mut value =
        serde_json::to_value(data).map_err(|_| Error::Dependency("签名结果序列化失败"))?;
    value["artifact_id"] = json!(session.input.artifact_id);
    Ok(value.into())
}
