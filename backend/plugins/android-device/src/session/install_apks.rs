//! APKS 私有副本、公共归档校验与固定 bundletool 编排；共用原 Session 收口。
use super::{Session, files};
use crate::{Error, Result, config::Config, rules::apks};
use apk_plugin_sdk::Request;
use deviceforge_android_package_core::apks::Selection;
use deviceforge_android_package_core::{
    ArchiveProfile, BuildMode, Control, android, archive::Archive,
};
use deviceforge_plugin_runtime::Output;
use serde_json::json;
use std::{
    fs::File,
    path::{Path, PathBuf},
};

impl Session {
    pub(super) async fn install_apks(
        &self,
        config: &Config,
        request: &Request,
        device_id: String,
        artifact_id: String,
        modules: Option<Vec<String>>,
        root: &Path,
    ) -> Result<Output> {
        self.control.check()?;
        Selection {
            modules: modules.clone(),
            instant: false,
        }
        .validate(&Control::new(
            Some(self.control.context.deadline()),
            &|| self.control.context.cancellation().is_cancelled(),
        ))
        .map_err(apks::package_error)?;
        let command = config.apks_command(&self.control.context).await?;
        let prepared = self
            .prepare_input(request, &artifact_id, root, "input.apks")
            .await?;
        self.validate_apks(prepared.path.clone()).await?;
        let mut args = command.prefix;
        args.extend([
            "install-apks".into(),
            format!(
                "--apks={}",
                prepared
                    .path
                    .to_str()
                    .ok_or(Error::Invalid("私有APKS路径须为UTF-8"))?
            ),
            format!("--device-id={device_id}"),
            format!(
                "--adb={}",
                command
                    .adb
                    .to_str()
                    .ok_or(Error::Invalid("ADB绝对路径须为UTF-8"))?
            ),
        ]);
        append_modules(&mut args, modules.as_deref());
        let captured = self
            .control
            .capture_private(&command.executable, &args, root)
            .await
            .map_err(|error| match error {
                Error::Dependency(_) => {
                    Error::Dependency("APKS工具调用失败，请检查设备、工具版本与包体兼容性")
                }
                other => other,
            })?;
        apks::install_output(&captured.stdout, &captured.stderr)?;
        self.control.check()?;
        Ok(Output::from(
            json!({"artifact_id":artifact_id,"device_id":device_id,"installed":true}),
        ))
    }

    async fn validate_apks(&self, path: PathBuf) -> Result<()> {
        let deadline = self.control.context.deadline();
        self.work(move |check| {
            check()?;
            let metadata = files::regular(&path, false)?;
            let file = File::open(&path).map_err(|_| Error::Io("APKS私有副本无法打开"))?;
            files::opened(&path, &file, &metadata)?;
            let cancelled = || check().is_err();
            let control = Control::new(Some(deadline), &cancelled);
            let mut archive = Archive::open(file, ArchiveProfile::Structure, &control)
                .map_err(apks::structure_error)?;
            android::validate_apks(&mut archive, BuildMode::Default, &control)
                .map_err(apks::package_error)?;
            check()
        })
        .await
    }
}

fn append_modules(args: &mut Vec<String>, modules: Option<&[String]>) {
    if let Some(modules) = modules {
        args.push(format!("--modules={}", modules.join(",")));
    }
}

#[cfg(test)]
mod tests;
