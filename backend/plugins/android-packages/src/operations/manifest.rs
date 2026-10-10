use super::input::ManifestInput;
use crate::{Error, Result, config::Tool, session::Session};
use deviceforge_plugin_runtime::Output;
use serde_json::json;

pub(super) async fn run(session: &Session, input: ManifestInput) -> Result<Output> {
    let apk = session
        .input
        .filename
        .to_ascii_lowercase()
        .ends_with(".apk");
    if apk && input.module.is_some() {
        return Err(Error::Invalid("APK 不接受 AAB 模块参数"));
    }
    let module = if apk {
        None
    } else {
        Some(input.module.unwrap_or_else(|| "base".into()))
    };
    let path = session.input.path.to_string_lossy().into_owned();
    let xml = if apk {
        session
            .tool(
                Tool::Apkanalyzer,
                vec!["manifest".into(), "print".into(), path],
            )
            .await?
    } else {
        session
            .tool(
                Tool::Bundletool,
                vec![
                    "dump".into(),
                    "manifest".into(),
                    format!("--bundle={path}"),
                    format!("--module={}", module.as_deref().unwrap_or("base")),
                ],
            )
            .await?
    };
    let data = session
        .work(move |control| {
            Ok(deviceforge_android_package_core::android::parse_manifest(
                &xml, control,
            )?)
        })
        .await?;
    let mut value =
        serde_json::to_value(data).map_err(|_| Error::Dependency("清单结果序列化失败"))?;
    value["artifact_id"] = json!(session.input.artifact_id);
    value["format"] = json!(if apk { "apk" } else { "aab" });
    value["module"] = json!(module);
    Ok(value.into())
}
