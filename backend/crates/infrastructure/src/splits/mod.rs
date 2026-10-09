mod packing;
use crate::{
    artifact_files::{Temporary, materialize},
    bundles::validation,
    package_tools::ToolCommand,
    process,
};
use apk_domain::{
    Error, Result,
    artifacts::ArtifactStore,
    bundles::BuildMode,
    splits::{
        ApksInstalled, ExtractSplitsRequest, ExtractedSplits, InstallApksRequest, SplitPackages,
    },
};
use async_trait::async_trait;
use futures_util::TryStreamExt;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio_util::{io::ReaderStream, sync::CancellationToken};
const TIMEOUT: Duration = Duration::from_secs(120);
pub struct AndroidSplits {
    artifacts: Arc<dyn ArtifactStore>,
    bundletool: Option<ToolCommand>,
    adb: String,
    devices: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
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
        Error::Cancelled | Error::Timeout => error,
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
        Self {
            artifacts,
            bundletool,
            adb,
            devices: Mutex::new(HashMap::new()),
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
    async fn extract_with_timeout(
        &self,
        request: ExtractSplitsRequest,
        cancel: CancellationToken,
        timeout: Duration,
    ) -> Result<ExtractedSplits> {
        request.validate()?;
        let token = cancel.child_token();
        let _cancel = CancelOnDrop(token.clone());
        let work = async {
            self.tool()?;
            let input = materialize(
                self.artifacts.as_ref(),
                &request.artifact_id,
                &[".apks"],
                token.clone(),
            )
            .await?;
            Self::validate_source(input.path.clone(), input.directory.clone(), token.clone())
                .await?;
            let spec = input.directory.path().join("device-spec.json");
            let payload = serde_json::json!({"supportedAbis":request.device_spec.supported_abis,
                "supportedLocales":request.device_spec.supported_locales,"screenDensity":request.device_spec.screen_density,
                "sdkVersion":request.device_spec.sdk_version});
            tokio::fs::write(
                &spec,
                serde_json::to_vec(&payload)
                    .map_err(|_| Error::Invalid("设备规格序列化失败".into()))?,
            )
            .await
            .map_err(|_| Error::Storage("设备规格写入失败".into()))?;
            let output = input.directory.path().join("selected");
            let running = self.run(
                vec![
                    "extract-apks".into(),
                    format!("--apks={}", input.path.display()),
                    format!("--output-dir={}", output.display()),
                    format!("--device-spec={}", spec.display()),
                ],
                &input.directory,
                token.clone(),
            );
            tokio::pin!(running);
            tokio::select! { biased;
                result = &mut running => { result?; }
                result = monitor(output.clone(), input.directory.clone(), token.clone()) => { token.cancel(); let _ = running.await; result?; }
            }
            let destination = input.directory.path().join("selected.zip");
            let target = destination.clone();
            let directory = input.directory.clone();
            let worker_token = token.clone();
            let apk_entries = tokio::task::spawn_blocking(move || {
                let _guard = directory;
                packing::pack(&output, &target, &worker_token)
            })
            .await
            .map_err(|_| Error::Dependency("分包打包任务失败".into()))??;
            let file = tokio::fs::File::open(destination)
                .await
                .map_err(|_| Error::Storage("读取分包产物失败".into()))?;
            let stream =
                ReaderStream::new(file).map_err(|_| Error::Storage("读取分包产物流失败".into()));
            let artifact = self
                .artifacts
                .put("selected-apks.zip".into(), Box::pin(stream))
                .await?;
            Ok(ExtractedSplits {
                source_artifact_id: request.artifact_id,
                device_spec: request.device_spec,
                artifact,
                apk_entries,
            })
        };
        tokio::select! { biased; _ = cancel.cancelled() => Err(Error::Cancelled),
        result = tokio::time::timeout(timeout, work) => result.unwrap_or(Err(Error::Timeout)) }
    }
}
async fn monitor(
    output: PathBuf,
    directory: Arc<Temporary>,
    cancel: CancellationToken,
) -> Result<()> {
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let path = output.clone();
        let guard = directory.clone();
        let token = cancel.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            if path.exists() {
                packing::check(&path, &token)?;
            }
            Ok::<_, Error>(())
        })
        .await
        .map_err(|_| Error::Dependency("分包输出监测失败".into()))??;
    }
}
#[async_trait]
impl SplitPackages for AndroidSplits {
    async fn extract(
        &self,
        request: ExtractSplitsRequest,
        cancel: CancellationToken,
    ) -> Result<ExtractedSplits> {
        self.extract_with_timeout(request, cancel, TIMEOUT).await
    }
    async fn install(
        &self,
        request: InstallApksRequest,
        cancel: CancellationToken,
    ) -> Result<ApksInstalled> {
        self.install_with_timeout(request, cancel, TIMEOUT).await
    }
}
#[cfg(test)]
mod tests;
