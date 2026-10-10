use super::{common, input::ArtifactInput};
use crate::{
    Result,
    config::Tool,
    session::{Session, Watch},
};
use deviceforge_android_package_core::TreeProfile;
use deviceforge_plugin_runtime::Output;
use serde_json::json;

pub(super) async fn run(session: &Session, _input: ArtifactInput) -> Result<Output> {
    let output = session.root.join("decoded");
    let framework = session.root.join("framework");
    session
        .monitored(
            Tool::Apktool,
            vec![
                "decode".into(),
                session.input.path.to_string_lossy().into_owned(),
                "--output".into(),
                output.to_string_lossy().into_owned(),
                "--frame-path".into(),
                framework.to_string_lossy().into_owned(),
            ],
            Watch::Tree {
                path: output.clone(),
                profile: TreeProfile::Reverse,
            },
        )
        .await?;
    let destination = session.root.join("decoded.zip");
    let packed = session
        .work(move |control| common::pack(&output, &destination, TreeProfile::Reverse, control))
        .await?;
    let artifact = session.publish("decoded.zip").await?;
    Ok(Output {
        value: json!({"files":packed.files,"unpacked_size":packed.unpacked_size}),
        artifacts: vec![artifact],
    })
}
