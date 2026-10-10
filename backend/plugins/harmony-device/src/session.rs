mod directory;
mod files;
mod input;
#[cfg(test)]
mod lifecycle;
mod worker;

use crate::{Control, Error, Result, config::Config, operations::Input};
use apk_plugin_sdk::{Request, cooperative::CleanupOutcome};
use deviceforge_plugin_runtime::{Execution, Output};
use serde_json::json;
use std::sync::{Arc, atomic::Ordering};

pub(crate) const FILE_LIMIT: u64 = 64 * 1024 * 1024;

pub(crate) struct Session {
    control: Control,
}

impl Session {
    pub(crate) async fn execute(
        control: Control,
        config: Config,
        request: &Request,
        input: Input,
    ) -> Execution {
        let session = Self { control };
        let result = session.run(config, request, input).await;
        session.finish(result).await
    }

    async fn run(&self, config: Config, request: &Request, input: Input) -> Result<Output> {
        self.control.check()?;
        let Input::Install {
            device_id,
            artifact_id,
        } = input
        else {
            return Err(Error::Invalid("非安装动作不能进入资源流程"));
        };
        let root = self
            .create_directory(config.scratch_root.unwrap_or_else(std::env::temp_dir))
            .await?;
        let prepared = self.prepare_input(request, &artifact_id, &root).await?;
        let path = prepared
            .path
            .to_str()
            .ok_or(Error::Invalid("私有安装路径须为UTF-8"))?;
        let args = vec!["-t".into(), device_id, "install".into(), path.into()];
        let captured = self.control.capture(&args).await?;
        let output = crate::rules::success(&captured.stdout, &captured.stderr, true)?;
        self.control.check()?;
        Ok(Output::from(
            json!({"artifact_id":artifact_id,"output":output.replace(path, &prepared.filename)}),
        ))
    }

    async fn finish(self, result: Result<Output>) -> Execution {
        let mut result = if matches!(result, Err(Error::CleanupFailed)) {
            result
        } else {
            self.control
                .context
                .check()
                .map_err(Error::from)
                .and(result)
        };
        let cleanup_ok = !matches!(result, Err(Error::CleanupFailed))
            && !self.control.unresolved.load(Ordering::Acquire)
            && Arc::strong_count(&self.control.lease) == 1
            && self.cleanup().await.is_ok();
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
        Input::Install { artifact_id, .. } => {
            let [artifact] = inputs else {
                return Err(Error::Invalid("安装要求唯一输入产物副本"));
            };
            if artifact.field != "/input/artifact_id" || artifact.artifact_id != *artifact_id {
                return Err(Error::Invalid("安装输入产物pointer或ID不一致"));
            }
            crate::rules::filename(&artifact.filename)?;
            if !artifact.filename.to_ascii_lowercase().ends_with(".hap") {
                return Err(Error::Invalid("安装仅接受HAP产物"));
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
    Ok(())
}

#[cfg(test)]
#[path = "session/validation.rs"]
mod validation;
