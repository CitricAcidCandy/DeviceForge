mod extract;
mod packing;
use crate::{
    artifact_files::{Temporary, materialize},
    bundles::validation,
    package_tools::{ToolCommand, tool::Tracker, worker::Pool},
    package_work::PackageCapacity,
    process,
};
use apk_domain::{
    Error, ExecutionContext, Result,
    artifacts::ArtifactStore,
    bundles::BuildMode,
    splits::{
        ApksInstalled, ExtractSplitsRequest, ExtractedSplits, InstallApksRequest, SplitPackages,
    },
};
use async_trait::async_trait;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
const TIMEOUT: Duration = Duration::from_secs(120);
pub struct AndroidSplits {
    artifacts: Arc<dyn ArtifactStore>,
    bundletool: Option<ToolCommand>,
    adb: String,
    devices: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
    workers: Pool,
    tools: Tracker,
}
struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
fn resolve_adb(configured: &str) -> Result<PathBuf> {
    let path = PathBuf::from(configured);
    let candidates = if path.is_absolute() || path.components().count() > 1 {
        vec![path]
    } else {
        std::env::var_os("PATH")
            .map(|paths| {
                std::env::split_paths(&paths)
                    .flat_map(|directory| {
                        let plain = directory.join(configured);
                        if cfg!(windows) && path.extension().is_none() {
                            vec![plain.clone(), plain.with_extension("exe")]
                        } else {
                            vec![plain]
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    candidates
        .into_iter()
        .find_map(|path| {
            if path.is_file() {
                std::fs::canonicalize(path).ok()
            } else {
                None
            }
        })
        .ok_or_else(|| Error::Dependency("APK_ADB 必须为现有工具路径或 PATH 中的工具名称".into()))
}
fn tool_error(error: Error) -> Error {
    match error {
        Error::Cancelled | Error::Timeout | Error::CleanupFailed => error,
        _ => Error::Dependency("APKS 工具调用失败，请检查设备、工具版本与包体兼容性".into()),
    }
}
fn failed_diagnostic(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    [
        "failure",
        "failed",
        "error",
        "unable",
        "cannot",
        "offline",
        "unauthorized",
        "no devices",
        "incompatible",
    ]
    .iter()
    .any(|word| lower.contains(word))
}
impl AndroidSplits {
    pub fn new(
        artifacts: Arc<dyn ArtifactStore>,
        bundletool: Option<ToolCommand>,
        adb: String,
    ) -> Self {
        Self::with_capacity(artifacts, bundletool, adb, PackageCapacity::default())
    }
    pub fn with_capacity(
        artifacts: Arc<dyn ArtifactStore>,
        bundletool: Option<ToolCommand>,
        adb: String,
        capacity: PackageCapacity,
    ) -> Self {
        Self {
            artifacts,
            bundletool,
            adb,
            devices: Mutex::new(HashMap::new()),
            workers: Pool::new(capacity),
            tools: Tracker::default(),
        }
    }
    fn tool(&self) -> Result<&ToolCommand> {
        self.bundletool
            .as_ref()
            .ok_or_else(|| Error::Dependency("部署者尚未配置 APK_BUNDLETOOL_JAR".into()))
    }
    fn device_lock(&self, device: &str) -> Result<Arc<tokio::sync::Mutex<()>>> {
        let mut devices = self
            .devices
            .lock()
            .map_err(|_| Error::Dependency("APKS 设备锁不可用".into()))?;
        devices.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = devices.get(device).and_then(Weak::upgrade) {
            return Ok(lock);
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        devices.insert(device.into(), Arc::downgrade(&lock));
        Ok(lock)
    }
    async fn run(
        &self,
        args: Vec<String>,
        directory: &Temporary,
        cancel: CancellationToken,
    ) -> Result<()> {
        let tool = self.tool()?;
        let args: Vec<_> = tool.prefix.iter().cloned().chain(args).collect();
        let output =
            process::isolated_text(&tool.executable, &args, TIMEOUT, cancel, directory.path())
                .await
                .map_err(tool_error)?;
        if failed_diagnostic(&output) {
            return Err(Error::Dependency("APKS 工具返回失败诊断".into()));
        }
        Ok(())
    }
    async fn validate_source(
        path: PathBuf,
        directory: Arc<Temporary>,
        cancel: CancellationToken,
    ) -> Result<()> {
        tokio::task::spawn_blocking(move || {
            let _guard = directory;
            validation::check(&path, BuildMode::Default, &cancel).map(|_| ())
        })
        .await
        .map_err(|_| Error::Dependency("APKS 校验任务失败".into()))?
    }
    async fn install_with_timeout(
        &self,
        request: InstallApksRequest,
        cancel: CancellationToken,
        timeout: Duration,
    ) -> Result<ApksInstalled> {
        request.validate()?;
        let token = cancel.child_token();
        let _cancel = CancelOnDrop(token.clone());
        let work = async {
            self.tool()?;
            let lock = self.device_lock(&request.device_id)?;
            let _guard = lock.lock().await;
            let input = materialize(
                self.artifacts.as_ref(),
                &request.artifact_id,
                &[".apks"],
                token.clone(),
            )
            .await?;
            Self::validate_source(input.path.clone(), input.directory.clone(), token.clone())
                .await?;
            let adb = resolve_adb(&self.adb)?;
            self.run(
                vec![
                    "install-apks".into(),
                    format!("--apks={}", input.path.display()),
                    format!("--device-id={}", request.device_id),
                    format!("--adb={}", adb.display()),
                ],
                &input.directory,
                token.clone(),
            )
            .await?;
            Ok(ApksInstalled {
                artifact_id: request.artifact_id,
                device_id: request.device_id,
                installed: true,
            })
        };
        tokio::select! { biased; _ = cancel.cancelled() => Err(Error::Cancelled),
        result = tokio::time::timeout(timeout, work) => result.unwrap_or(Err(Error::Timeout)) }
    }
}
#[async_trait]
impl SplitPackages for AndroidSplits {
    async fn extract(
        &self,
        request: ExtractSplitsRequest,
        cancel: CancellationToken,
    ) -> Result<ExtractedSplits> {
        self.extract_with_context(request, cancel, ExecutionContext::default())
            .await
    }
    async fn extract_with_context(
        &self,
        request: ExtractSplitsRequest,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<ExtractedSplits> {
        extract::run(self, request, cancel, context).await
    }
    async fn install(
        &self,
        request: InstallApksRequest,
        cancel: CancellationToken,
    ) -> Result<ApksInstalled> {
        self.install_with_timeout(request, cancel, TIMEOUT).await
    }
    fn has_unresolved_resources(&self) -> bool {
        self.workers.unresolved() || self.tools.unresolved()
    }
}
#[cfg(test)]
mod tests;
