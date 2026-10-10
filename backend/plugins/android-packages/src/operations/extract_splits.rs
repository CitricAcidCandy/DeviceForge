use super::{common, input::SplitsInput};
use crate::{
    Error, Result,
    config::Tool,
    session::{Session, Watch},
};
use deviceforge_android_package_core::{BuildMode, TreeProfile};
use deviceforge_plugin_runtime::Output;
use serde_json::json;

pub(super) async fn run(session: &Session, input: SplitsInput) -> Result<Output> {
    let path = session.input.path.clone();
    session
        .work(move |control| {
            let mut archive = common::archive(&path, control)?;
            deviceforge_android_package_core::android::validate_apks(
                &mut archive,
                BuildMode::Default,
                control,
            )?;
            Ok(())
        })
        .await?;
    let payload = json!({
        "supportedAbis":input.device_spec.supported_abis,
        "supportedLocales":input.device_spec.supported_locales,
        "screenDensity":input.device_spec.screen_density,
        "sdkVersion":input.device_spec.sdk_version,
    });
    let bytes = serde_json::to_vec(&payload).map_err(|_| Error::Invalid("设备规格序列化失败"))?;
    let spec = session.write_private("device-spec.json", &bytes).await?;
    let output = session.root.join("selected");
    let diagnostic = session
        .monitored(
            Tool::Bundletool,
            vec![
                "extract-apks".into(),
                format!("--apks={}", session.input.path.display()),
                format!("--output-dir={}", output.display()),
                format!("--device-spec={}", spec.display()),
            ],
            Watch::Tree {
                path: output.clone(),
                profile: TreeProfile::Splits,
            },
        )
        .await?;
    if common::failed_diagnostic(&diagnostic) {
        return Err(Error::Dependency("APKS 工具返回失败诊断"));
    }
    let destination = session.root.join("selected-apks.zip");
    let packed = session
        .work(move |control| common::pack(&output, &destination, TreeProfile::Splits, control))
        .await?;
    let artifact = session.publish("selected-apks.zip").await?;
    Ok(Output {
        value: json!({"device_spec":input.device_spec,"apk_entries":packed.entries}),
        artifacts: vec![artifact],
    })
}
