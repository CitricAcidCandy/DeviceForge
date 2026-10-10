use super::{common, input::ScanInput};
use crate::{Result, session::Session};
use deviceforge_plugin_runtime::Output;
use serde_json::json;

pub(super) async fn run(session: &Session, input: ScanInput) -> Result<Output> {
    let path = session.input.path.clone();
    let rules: Vec<_> = input
        .rules
        .into_iter()
        .map(|rule| deviceforge_android_package_core::SdkRule {
            name: rule.name,
            package_path: rule.package_path,
            class_name: rule.class_name,
        })
        .collect();
    let findings = session
        .work(move |control| {
            let archive = common::archive(&path, control)?;
            deviceforge_android_package_core::android::validate_decoded(archive.directory())?;
            Ok(deviceforge_android_package_core::android::scan_sdks(
                archive.directory(),
                &rules,
                control,
            )?)
        })
        .await?;
    Ok(json!({"artifact_id":session.input.artifact_id,"findings":findings}).into())
}
