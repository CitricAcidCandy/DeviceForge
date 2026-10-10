mod build;
pub(crate) mod validation;
use crate::{
    package_tools::{ToolCommand, tool::Tracker, worker::Pool},
    package_work::PackageCapacity,
};
use apk_domain::{
    Error, ExecutionContext, Result,
    artifacts::ArtifactStore,
    bundles::{BuildApksRequest, BuiltApks, BundleBuilder},
};
use async_trait::async_trait;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
const TIMEOUT: Duration = Duration::from_secs(120);

/// 签名配置只来自部署；密码通过文件交给工具，不读入任务输入或命令参数。
#[derive(Clone)]
pub struct BundleSigning {
    pub keystore: PathBuf,
    pub alias: String,
    pub store_password_file: PathBuf,
    pub key_password_file: PathBuf,
}
impl BundleSigning {
    pub fn validate(&self) -> Result<()> {
        if self.alias.is_empty()
            || self.alias.len() > 100
            || self.alias.chars().any(char::is_control)
        {
            return Err(Error::Invalid("部署签名别名无效".into()));
        }
        for path in [
            &self.keystore,
            &self.store_password_file,
            &self.key_password_file,
        ] {
            if !path.is_absolute() || !path.is_file() {
                return Err(Error::Invalid(
                    "部署签名配置必须指向现有文件的绝对路径".into(),
                ));
            }
        }
        Ok(())
    }
    fn arguments(&self) -> Vec<String> {
        vec![
            format!("--ks={}", self.keystore.display()),
            format!("--ks-key-alias={}", self.alias),
            format!("--ks-pass=file:{}", self.store_password_file.display()),
            format!("--key-pass=file:{}", self.key_password_file.display()),
        ]
    }
}
pub struct AndroidBundles {
    pub artifacts: Arc<dyn ArtifactStore>,
    pub bundletool: Option<ToolCommand>,
    pub signing: Option<BundleSigning>,
    workers: Pool,
    tools: Tracker,
}
impl AndroidBundles {
    pub fn new(
        artifacts: Arc<dyn ArtifactStore>,
        bundletool: Option<ToolCommand>,
        signing: Option<BundleSigning>,
    ) -> Self {
        Self::with_capacity(artifacts, bundletool, signing, PackageCapacity::default())
    }
    pub fn with_capacity(
        artifacts: Arc<dyn ArtifactStore>,
        bundletool: Option<ToolCommand>,
        signing: Option<BundleSigning>,
        capacity: PackageCapacity,
    ) -> Self {
        Self {
            artifacts,
            bundletool,
            signing,
            workers: Pool::new(capacity),
            tools: Tracker::default(),
        }
    }
    #[cfg(test)]
    async fn build_with_timeout(
        &self,
        request: BuildApksRequest,
        cancel: CancellationToken,
        timeout: Duration,
    ) -> Result<BuiltApks> {
        build::run(
            self,
            request,
            cancel,
            ExecutionContext {
                deadline: Some((tokio::time::Instant::now() + timeout).into_std()),
            },
        )
        .await
    }
}
#[async_trait]
impl BundleBuilder for AndroidBundles {
    async fn build(
        &self,
        request: BuildApksRequest,
        cancel: CancellationToken,
    ) -> Result<BuiltApks> {
        self.build_with_context(request, cancel, ExecutionContext::default())
            .await
    }
    async fn build_with_context(
        &self,
        request: BuildApksRequest,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<BuiltApks> {
        build::run(self, request, cancel, context).await
    }
    fn has_unresolved_resources(&self) -> bool {
        self.workers.unresolved() || self.tools.unresolved()
    }
}
#[cfg(test)]
mod tests;
