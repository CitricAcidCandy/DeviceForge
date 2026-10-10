use super::{common, input::BuildInput};
use crate::{
    Error, Result,
    config::Tool,
    session::{Session, Watch},
};
use deviceforge_plugin_runtime::Output;
use serde_json::json;

pub(super) async fn run(session: &Session, input: BuildInput) -> Result<Output> {
    let signing = session.signing().await?;
    let destination = session.root.join("built.apks");
    let args = vec![
        "build-apks".into(),
        format!("--bundle={}", session.input.path.display()),
        format!("--output={}", destination.display()),
        format!("--mode={}", input.mode.argument()),
        "--max-threads=2".into(),
        format!("--ks={}", signing.keystore.display()),
        format!("--ks-key-alias={}", signing.alias),
        format!("--ks-pass=file:{}", signing.store_password_file.display()),
        format!("--key-pass=file:{}", signing.key_password_file.display()),
    ];
    session
        .monitored(
            Tool::Bundletool,
            args,
            Watch::File {
                path: destination.clone(),
                limit: common::LIMIT,
            },
        )
        .await
        .map_err(|error| match error {
            Error::Dependency(_) => Error::Dependency("AAB 构建工具失败，请检查工具和签名配置"),
            other => other,
        })?;
    let mode = input.mode.core();
    let summary = session
        .work(move |control| {
            let mut archive = common::archive(&destination, control)?;
            Ok(deviceforge_android_package_core::android::validate_apks(
                &mut archive,
                mode,
                control,
            )?)
        })
        .await?;
    let artifact = session.publish("built.apks").await?;
    Ok(Output {
        value: json!({"mode":input.mode,"apk_count":summary.apk_count,"universal_entry":summary.universal_entry}),
        artifacts: vec![artifact],
    })
}
