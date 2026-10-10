mod extract;
mod manifest;
pub(crate) mod monitored;
mod signature;
pub(crate) mod tool;
pub(crate) mod tree_monitor;
pub(crate) mod worker;
use crate::{artifact_files::materialize_until, execution_deadline};
use apk_domain::{
    Error, ExecutionContext, Result,
    artifacts::ArtifactStore,
    packages::{ExtractedApk, PackageAnalyzer, PackageFormat, PackageManifest, PackageSignature},
};
use async_trait::async_trait;
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
pub use tool::ToolCommand;
const TIMEOUT: Duration = Duration::from_secs(120);

pub struct AndroidPackageTools {
    pub artifacts: Arc<dyn ArtifactStore>,
    pub apkanalyzer: ToolCommand,
    pub apksigner: ToolCommand,
    pub bundletool: Option<ToolCommand>,
    workers: worker::Pool,
    tools: tool::Tracker,
}
impl AndroidPackageTools {
    pub fn new(
        artifacts: Arc<dyn ArtifactStore>,
        apkanalyzer: ToolCommand,
        apksigner: ToolCommand,
        bundletool: Option<ToolCommand>,
    ) -> Self {
        Self::with_capacity(
            artifacts,
            apkanalyzer,
            apksigner,
            bundletool,
            crate::package_work::PackageCapacity::default(),
        )
    }
    pub fn with_capacity(
        artifacts: Arc<dyn ArtifactStore>,
        apkanalyzer: ToolCommand,
        apksigner: ToolCommand,
        bundletool: Option<ToolCommand>,
        capacity: crate::package_work::PackageCapacity,
    ) -> Self {
        Self {
            artifacts,
            apkanalyzer,
            apksigner,
            bundletool,
            workers: worker::Pool::new(capacity),
            tools: tool::Tracker::default(),
        }
    }
}
fn control_error(error: deviceforge_android_package_core::Error) -> Error {
    match error {
        deviceforge_android_package_core::Error::Timeout => Error::Timeout,
        deviceforge_android_package_core::Error::Cancelled => Error::Cancelled,
        _ => Error::Dependency("包工作控制异常".into()),
    }
}
fn module_name(module: &str) -> Result<()> {
    if module.is_empty()
        || module.len() > 80
        || !module.as_bytes()[0].is_ascii_alphabetic()
        || !module
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
    {
        return Err(Error::Invalid(
            "AAB 模块名必须以字母开头，仅含字母、数字和下划线，最多 80 字节".into(),
        ));
    }
    Ok(())
}
#[async_trait]
impl PackageAnalyzer for AndroidPackageTools {
    async fn manifest(
        &self,
        id: &str,
        module: Option<&str>,
        cancel: CancellationToken,
    ) -> Result<PackageManifest> {
        self.manifest_with_context(id, module, cancel, ExecutionContext::default())
            .await
    }
    async fn manifest_with_context(
        &self,
        id: &str,
        module: Option<&str>,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<PackageManifest> {
        let point = context.deadline.map(tokio::time::Instant::from_std);
        execution_deadline::check(&cancel, point)?;
        if let Some(module) = module {
            module_name(module)?;
        }
        let input = materialize_until(
            self.artifacts.as_ref(),
            id,
            &[".apk", ".aab"],
            cancel.clone(),
            point,
        )
        .await?;
        let path = input.path.to_string_lossy().into_owned();
        if input
            .artifact
            .filename
            .to_ascii_lowercase()
            .ends_with(".apk")
        {
            if module.is_some() {
                return Err(Error::Invalid("APK 不接受 AAB 模块参数".into()));
            }
            let xml = self
                .tools
                .output_held(
                    &self.apkanalyzer,
                    vec!["manifest".into(), "print".into(), path],
                    cancel.clone(),
                    context.deadline,
                    input.directory.clone(),
                )
                .await?;
            let id = id.to_owned();
            let deadline = context
                .deadline
                .or_else(|| Some((tokio::time::Instant::now() + TIMEOUT).into_std()));
            self.workers
                .run(cancel, deadline, move |control| {
                    let _lease = input.directory;
                    manifest::controlled(&id, PackageFormat::Apk, None, xml, control)
                })
                .await
        } else {
            let module = module.unwrap_or("base");
            let tool = self
                .bundletool
                .as_ref()
                .ok_or_else(|| Error::Dependency("部署者尚未配置 APK_BUNDLETOOL_JAR".into()))?;
            let xml = self
                .tools
                .output_held(
                    tool,
                    vec![
                        "dump".into(),
                        "manifest".into(),
                        format!("--bundle={path}"),
                        format!("--module={module}"),
                    ],
                    cancel.clone(),
                    context.deadline,
                    input.directory.clone(),
                )
                .await?;
            let id = id.to_owned();
            let module = module.to_owned();
            let deadline = context
                .deadline
                .or_else(|| Some((tokio::time::Instant::now() + TIMEOUT).into_std()));
            self.workers
                .run(cancel, deadline, move |control| {
                    let _lease = input.directory;
                    manifest::controlled(&id, PackageFormat::Aab, Some(module), xml, control)
                })
                .await
        }
    }
    async fn signature(&self, id: &str, cancel: CancellationToken) -> Result<PackageSignature> {
        self.signature_with_context(id, cancel, ExecutionContext::default())
            .await
    }
    async fn signature_with_context(
        &self,
        id: &str,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<PackageSignature> {
        let point = context.deadline.map(tokio::time::Instant::from_std);
        execution_deadline::check(&cancel, point)?;
        let input = materialize_until(
            self.artifacts.as_ref(),
            id,
            &[".apk"],
            cancel.clone(),
            point,
        )
        .await?;
        let report = self
            .tools
            .output_held(
                &self.apksigner,
                vec![
                    "verify".into(),
                    "--verbose".into(),
                    "--print-certs".into(),
                    input.path.to_string_lossy().into_owned(),
                ],
                cancel.clone(),
                context.deadline,
                input.directory.clone(),
            )
            .await?;
        let report = report.replace(
            input.path.to_string_lossy().as_ref(),
            &input.artifact.filename,
        );
        let id = id.to_owned();
        let deadline = context
            .deadline
            .or_else(|| Some((tokio::time::Instant::now() + TIMEOUT).into_std()));
        self.workers
            .run(cancel, deadline, move |control| {
                let _lease = input.directory;
                signature::controlled(&id, report, control)
            })
            .await
    }
    async fn extract_apk(
        &self,
        id: &str,
        entry: &str,
        cancel: CancellationToken,
    ) -> Result<ExtractedApk> {
        self.extract_apk_with_context(id, entry, cancel, ExecutionContext::default())
            .await
    }
    async fn extract_apk_with_context(
        &self,
        id: &str,
        entry: &str,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<ExtractedApk> {
        extract::run(self, id, entry, cancel, context).await
    }
    fn has_unresolved_resources(&self) -> bool {
        self.workers.unresolved() || self.tools.unresolved()
    }
}
#[cfg(test)]
mod tests;
