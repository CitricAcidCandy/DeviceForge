mod directory;
pub(crate) mod files;
mod input;
mod install_apks;
#[cfg(test)]
pub(crate) mod lifecycle;
mod output;
mod performance;
pub(crate) mod unicode;
mod worker;

use crate::{Control, Error, Result, config::Config, operations::Input};
use apk_plugin_sdk::{Request, cooperative::CleanupOutcome};
use deviceforge_plugin_runtime::{Execution, Output};
use serde_json::json;
use std::sync::{Arc, atomic::Ordering};

pub(crate) const FILE_LIMIT: u64 = 64 * 1024 * 1024;

pub(crate) struct Session {
    pub(crate) control: Control,
    pub(crate) profile_root: Option<crate::profile::root::Access>,
}

impl Session {
    pub(crate) async fn execute(
        control: Control,
        config: Config,
        request: &Request,
        input: Input,
    ) -> Execution {
        let mut session = Self {
            control,
            profile_root: None,
        };
        let result = session.run(config, request, input).await;
        session.finish(result).await
    }

    async fn run(&mut self, config: Config, request: &Request, input: Input) -> Result<Output> {
        self.control.check()?;
        let input = match input {
            Input::Performance { device_id, package } => {
                return self.sample(device_id, package).await;
            }
            Input::StackProbe { device_id, package } => {
                return self.stack_probe(device_id, package, &config.profile).await;
            }
            other => other,
        };
        let root = self
            .create_directory(
                config
                    .scratch_root
                    .clone()
                    .unwrap_or_else(std::env::temp_dir),
            )
            .await?;
        match input {
            Input::ProfileRecord { device_id, options } => {
                self.record_profile(&config, request, device_id, options, root)
                    .await
            }
            Input::Install {
                device_id,
                artifact_id,
            } => {
                let prepared = self
                    .prepare_input(request, &artifact_id, &root, "input.apk")
                    .await?;
                let path = prepared
                    .path
                    .to_str()
                    .ok_or(Error::Invalid("私有安装路径须为UTF-8"))?;
                let args = vec!["-s".into(), device_id, "install".into(), path.into()];
                let captured = self.control.capture_scoped(&args).await?;
                let output =
                    crate::rules::artifacts::install_output(&captured.stdout, &captured.stderr)?;
                self.control.check()?;
                Ok(Output::from(
                    json!({"artifact_id":artifact_id,"output":output.replace(path, &prepared.filename)}),
                ))
            }
            Input::InstallApks {
                device_id,
                artifact_id,
                modules,
            } => {
                self.install_apks(&config, request, device_id, artifact_id, modules, &root)
                    .await
            }
            Input::Screenshot { device_id } => {
                let source = root.join("screenshot.png");
                let path = source.clone();
                let file = self
                    .work(move |check| {
                        check()?;
                        files::create(&path)
                    })
                    .await?;
                let args = vec![
                    "-s".into(),
                    device_id,
                    "exec-out".into(),
                    "screencap".into(),
                    "-p".into(),
                ];
                self.control.capture_file(args, file).await?;
                self.publish(request, source).await
            }
            _ => Err(Error::Invalid("该设备动作不能进入资源流程")),
        }
    }

    async fn finish(self, result: Result<Output>) -> Execution {
        let result = if matches!(result, Err(Error::CleanupFailed)) {
            result
        } else {
            self.control
                .context
                .check()
                .map_err(Error::from)
                .and(result)
        };
        let failed_before_cleanup = result.is_err();
        let cleanup_ok = !matches!(result, Err(Error::CleanupFailed))
            && !self.control.unresolved.load(Ordering::Acquire)
            && Arc::strong_count(&self.control.lease) == 1
            && self.cleanup(failed_before_cleanup).await.is_ok();
        self.finish_cleaned(result, failed_before_cleanup, cleanup_ok)
            .await
    }

    async fn finish_cleaned(
        self,
        mut result: Result<Output>,
        failed_before_cleanup: bool,
        cleanup_ok: bool,
    ) -> Execution {
        if !cleanup_ok {
            self.control.unresolved.store(true, Ordering::Release);
            result = Err(Error::CleanupFailed);
        } else {
            result = self
                .control
                .context
                .check()
                .map_err(Error::from)
                .and(result);
            if result.is_err() && !failed_before_cleanup {
                if self.cleanup(true).await.is_err() {
                    self.control.unresolved.store(true, Ordering::Release);
                    result = Err(Error::CleanupFailed);
                } else {
                    result = self
                        .control
                        .context
                        .check()
                        .map_err(Error::from)
                        .and(result);
                }
            }
        }
        let complete = !matches!(result, Err(Error::CleanupFailed))
            && !self.control.unresolved.load(Ordering::Acquire)
            && Arc::strong_count(&self.control.lease) == 1;
        if !complete {
            result = Err(Error::CleanupFailed);
        }
        Execution {
            outcome: result.map_err(|error| error.to_string()),
            cleanup: if complete {
                CleanupOutcome::Complete
            } else {
                CleanupOutcome::Failed
            },
        }
    }
}

pub(crate) fn validate_context(request: &Request, input: &Input) -> Result<()> {
    let inputs = request
        .artifacts
        .as_ref()
        .map(|artifacts| artifacts.inputs.as_slice())
        .unwrap_or_default();
    match input {
        Input::Install { artifact_id, .. } | Input::InstallApks { artifact_id, .. } => {
            let [artifact] = inputs else {
                return Err(Error::Invalid("安装要求唯一输入产物副本"));
            };
            if artifact.field != "/input/artifact_id" || artifact.artifact_id != *artifact_id {
                return Err(Error::Invalid("安装输入产物pointer或ID不一致"));
            }
            crate::rules::artifacts::filename(&artifact.filename)?;
            let (extension, message) = if matches!(input, Input::InstallApks { .. }) {
                (".apks", "分包安装仅接受APKS产物")
            } else {
                (".apk", "安装仅接受APK产物")
            };
            if !artifact.filename.to_ascii_lowercase().ends_with(extension) {
                return Err(Error::Invalid(message));
            }
            if artifact.size > FILE_LIMIT {
                return Err(Error::TooLarge);
            }
            if artifact.sha256.len() != 64
                || !artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(Error::Invalid("输入产物摘要无效"));
            }
        }
        _ if !inputs.is_empty() => return Err(Error::Invalid("该设备动作不接受输入产物")),
        _ => {}
    }
    if matches!(
        input,
        Input::Screenshot { .. } | Input::ProfileRecord { .. }
    ) && request
        .artifacts
        .as_ref()
        .and_then(|artifacts| artifacts.output_directory.as_ref())
        .is_none()
    {
        return Err(Error::Invalid("截图缺少宿主输出授权"));
    }
    if matches!(input, Input::Performance { .. })
        && request
            .artifacts
            .as_ref()
            .and_then(|artifacts| artifacts.output_directory.as_ref())
            .is_some()
    {
        return Err(Error::Invalid("性能采样不接受产物输出授权"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use apk_plugin_sdk::{ArtifactContext, ArtifactInput};

    fn request() -> Request {
        Request {
            protocol_version: 4,
            request_id: "strict-install".into(),
            operation: "app.install".into(),
            input: serde_json::Value::Null,
            artifacts: Some(ArtifactContext {
                inputs: vec![ArtifactInput {
                    field: "/input/artifact_id".into(),
                    artifact_id: "d0da1b1b-919c-40a8-9c71-fbb56614e488".into(),
                    filename: "示例.APK".into(),
                    size: 10,
                    sha256: "0".repeat(64),
                    path: "unused-before-configuration".into(),
                }],
                output_directory: None,
            }),
        }
    }

    fn install() -> Input {
        Input::Install {
            device_id: "serial".into(),
            artifact_id: "d0da1b1b-919c-40a8-9c71-fbb56614e488".into(),
        }
    }

    #[test]
    fn installation_matches_unique_nested_pointer_and_id_without_output_authorization() {
        assert!(validate_context(&request(), &install()).is_ok());
        for field in ["artifact_id", "/other/artifact_id"] {
            let mut value = request();
            value.artifacts.as_mut().unwrap().inputs[0].field = field.into();
            assert!(validate_context(&value, &install()).is_err());
        }
        let mut value = request();
        let artifacts = value.artifacts.as_mut().unwrap();
        artifacts.inputs.push(artifacts.inputs[0].clone());
        assert!(validate_context(&value, &install()).is_err());
        value.artifacts.as_mut().unwrap().inputs.clear();
        assert!(validate_context(&value, &install()).is_err());
    }

    #[test]
    fn installation_rejects_bad_metadata_and_wrong_id_before_io() {
        for mutation in 0..4 {
            let mut value = request();
            let input = &mut value.artifacts.as_mut().unwrap().inputs[0];
            match mutation {
                0 => input.artifact_id = "ffffffff-ffff-ffff-ffff-ffffffffffff".into(),
                1 => input.filename = "package.hap".into(),
                2 => input.size = FILE_LIMIT + 1,
                _ => input.sha256 = "invalid".into(),
            }
            assert!(validate_context(&value, &install()).is_err());
        }
    }

    #[test]
    fn apks_installation_uses_the_same_authorization_but_requires_an_apks_filename() {
        let input = Input::InstallApks {
            device_id: "serial".into(),
            artifact_id: "d0da1b1b-919c-40a8-9c71-fbb56614e488".into(),
            modules: None,
        };
        let mut value = request();
        assert!(validate_context(&value, &input).is_err());
        value.artifacts.as_mut().unwrap().inputs[0].filename = "分包.APKS".into();
        assert!(validate_context(&value, &input).is_ok());
        value.artifacts.as_mut().unwrap().inputs[0].field = "artifact_id".into();
        assert!(validate_context(&value, &input).is_err());
    }

    #[test]
    fn old_empty_context_is_legal_and_screenshot_requires_output_authorization() {
        let mut value = request();
        assert!(validate_context(&value, &Input::Discover).is_err());
        value.artifacts.as_mut().unwrap().inputs.clear();
        assert!(validate_context(&value, &Input::Discover).is_ok());
        let screenshot = Input::Screenshot {
            device_id: "serial".into(),
        };
        assert!(validate_context(&value, &screenshot).is_err());
        value.artifacts.as_mut().unwrap().output_directory =
            Some("unused-before-configuration".into());
        assert!(validate_context(&value, &screenshot).is_ok());
    }
}

#[cfg(test)]
mod profile_context_tests {
    use super::*;
    use apk_plugin_sdk::ArtifactContext;
    #[test]
    fn probe_accepts_host_granted_empty_output_but_never_accepts_input_artifacts() {
        let mut request = Request {
            protocol_version: 4,
            request_id: "probe-output-context".into(),
            operation: "stack.probe".into(),
            input: serde_json::Value::Null,
            artifacts: Some(ArtifactContext {
                inputs: Vec::new(),
                output_directory: Some("host-output-only".into()),
            }),
        };
        let input = Input::StackProbe {
            device_id: "serial".into(),
            package: "com.example.game".into(),
        };
        assert!(validate_context(&request, &input).is_ok());
        let performance = Input::Performance {
            device_id: "serial".into(),
            package: "com.example.game".into(),
        };
        assert!(validate_context(&request, &performance).is_err());
        request
            .artifacts
            .as_mut()
            .unwrap()
            .inputs
            .push(apk_plugin_sdk::ArtifactInput {
                field: "/input/package".into(),
                artifact_id: "independent".into(),
                filename: "input.apk".into(),
                size: 1,
                sha256: "0".repeat(64),
                path: "unused".into(),
            });
        assert!(matches!(
            validate_context(&request, &input),
            Err(Error::Invalid("该设备动作不接受输入产物"))
        ));
    }
}
