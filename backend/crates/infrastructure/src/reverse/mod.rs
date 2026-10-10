mod decode;
mod packing;
mod scanning;
use crate::{
    artifact_files::materialize_until,
    execution_deadline,
    package_tools::{ToolCommand, tool::Tracker, worker::Pool},
    package_work::PackageCapacity,
};
#[cfg(test)]
use apk_domain::Error;
use apk_domain::{
    ExecutionContext, Result,
    artifacts::ArtifactStore,
    reverse::{DecodedPackage, PackageReverse, SdkRule, SdkScan},
};
use async_trait::async_trait;
#[cfg(test)]
use futures_util::TryStreamExt;
use std::{sync::Arc, time::Duration};
#[cfg(test)]
use tokio_util::io::ReaderStream;
use tokio_util::sync::CancellationToken;
const TIMEOUT: Duration = Duration::from_secs(120);

pub struct AndroidReverse {
    pub artifacts: Arc<dyn ArtifactStore>,
    pub apktool: Option<ToolCommand>,
    workers: Pool,
    tools: Tracker,
}
impl AndroidReverse {
    pub fn new(artifacts: Arc<dyn ArtifactStore>, apktool: Option<ToolCommand>) -> Self {
        Self::with_capacity(artifacts, apktool, PackageCapacity::default())
    }
    pub fn with_capacity(
        artifacts: Arc<dyn ArtifactStore>,
        apktool: Option<ToolCommand>,
        capacity: PackageCapacity,
    ) -> Self {
        Self {
            artifacts,
            apktool,
            workers: Pool::new(capacity),
            tools: Tracker::default(),
        }
    }
}
// None 保留旧入口各阶段限额；Some 原点在所有阶段原样复用。
fn stage(context: ExecutionContext) -> tokio::time::Instant {
    context
        .deadline
        .map(tokio::time::Instant::from_std)
        .unwrap_or_else(|| tokio::time::Instant::now() + TIMEOUT)
}
#[async_trait]
impl PackageReverse for AndroidReverse {
    async fn decode(&self, id: &str, cancel: CancellationToken) -> Result<DecodedPackage> {
        self.decode_with_context(id, cancel, ExecutionContext::default())
            .await
    }
    async fn decode_with_context(
        &self,
        id: &str,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<DecodedPackage> {
        decode::run(self, id, cancel, context).await
    }
    async fn scan_sdks(
        &self,
        id: &str,
        rules: Vec<SdkRule>,
        cancel: CancellationToken,
    ) -> Result<SdkScan> {
        self.scan_sdks_with_context(id, rules, cancel, ExecutionContext::default())
            .await
    }
    async fn scan_sdks_with_context(
        &self,
        id: &str,
        rules: Vec<SdkRule>,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<SdkScan> {
        let input_point = stage(context);
        execution_deadline::check(&cancel, Some(input_point))?;
        scanning::validate(&rules)?;
        let input = materialize_until(
            self.artifacts.as_ref(),
            id,
            &[".zip"],
            cancel.clone(),
            Some(input_point),
        )
        .await?;
        let point = stage(context);
        let id = id.to_owned();
        execution_deadline::run(
            &cancel,
            Some(point),
            self.workers
                .run(cancel.clone(), Some(point.into_std()), move |control| {
                    let _lease = input.directory;
                    scanning::controlled(&input.path, &id, rules, control)
                }),
        )
        .await
    }
    fn has_unresolved_resources(&self) -> bool {
        self.workers.unresolved() || self.tools.unresolved()
    }
}
#[cfg(test)]
mod tests;
