use super::{common, input::SplitsInput};
use crate::{
    Error, Result,
    config::Tool,
    session::{Session, Watch},
};
use deviceforge_android_package_core::apks::Selection;
use deviceforge_android_package_core::{BuildMode, TreeProfile};
use deviceforge_plugin_runtime::Output;
use serde_json::json;
use std::path::Path;

pub(super) async fn run(session: &Session, input: SplitsInput) -> Result<Output> {
    let path = session.input.path.clone();
    let selection = Selection {
        modules: input.modules,
        instant: input.instant,
    };
    let selected = selection.clone();
    let device_spec = input.device_spec.clone();
    session
        .work(move |control| {
            device_spec.validate(control)?;
            selected.validate(control)?;
            let mut archive = common::archive(&path, control)?;
            deviceforge_android_package_core::android::validate_apks(
                &mut archive,
                BuildMode::Default,
                control,
            )?;
            Ok(())
        })
        .await?;
    let payload = serde_json::to_value(input.device_spec.bundletool())
        .map_err(|_| Error::Invalid("设备规格序列化失败"))?;
    let bytes = serde_json::to_vec(&payload).map_err(|_| Error::Invalid("设备规格序列化失败"))?;
    let spec = session.write_private("device-spec.json", &bytes).await?;
    let output = session.root.join("selected");
    let diagnostic = session
        .monitored(
            Tool::Bundletool,
            arguments(&session.input.path, &output, &spec, &selection),
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

fn arguments(apks: &Path, output: &Path, spec: &Path, selection: &Selection) -> Vec<String> {
    let mut args = vec![
        "extract-apks".into(),
        format!("--apks={}", apks.display()),
        format!("--output-dir={}", output.display()),
        format!("--device-spec={}", spec.display()),
    ];
    if let Some(modules) = &selection.modules {
        args.push(format!("--modules={}", modules.join(",")));
    }
    if selection.instant {
        args.push("--instant".into());
    }
    args
}

#[cfg(test)]
mod tests;
