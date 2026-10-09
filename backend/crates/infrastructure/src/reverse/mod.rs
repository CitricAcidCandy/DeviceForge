mod packing;
mod scanning;
use crate::{artifact_files::materialize, package_tools::ToolCommand};
use apk_domain::{
    Error, Result,
    artifacts::ArtifactStore,
    reverse::{DecodedPackage, PackageReverse, SdkRule, SdkScan},
};
use async_trait::async_trait;
use futures_util::TryStreamExt;
use std::{sync::Arc, time::Duration};
use tokio_util::{io::ReaderStream, sync::CancellationToken};
const TIMEOUT: Duration = Duration::from_secs(120);

async fn monitor_output(
    output: std::path::PathBuf,
    directory: Arc<crate::artifact_files::Temporary>,
    cancel: CancellationToken,
) -> Result<()> {
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let root = output.clone();
        let directory = directory.clone();
        let token = cancel.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = directory;
            if root.exists() {
                packing::check(&root, &token)?;
            }
            Ok::<_, Error>(())
        })
        .await
        .map_err(|e| Error::Dependency(e.to_string()))??;
    }
}
pub struct AndroidReverse {
    pub artifacts: Arc<dyn ArtifactStore>,
    pub apktool: Option<ToolCommand>,
}
#[async_trait]
impl PackageReverse for AndroidReverse {
    async fn decode(&self, id: &str, cancel: CancellationToken) -> Result<DecodedPackage> {
        let tool = self
            .apktool
            .as_ref()
            .ok_or_else(|| Error::Dependency("部署者尚未配置 APK_APKTOOL_JAR".into()))?;
        let input = materialize(self.artifacts.as_ref(), id, &[".apk"], cancel.clone()).await?;
        let output = input.directory.path().join("decoded");
        let framework = input.directory.path().join("framework");
        let args = vec![
            "decode".into(),
            input.path.to_string_lossy().into_owned(),
            "--output".into(),
            output.to_string_lossy().into_owned(),
            "--frame-path".into(),
            framework.to_string_lossy().into_owned(),
        ];
        let process_cancel = cancel.child_token();
        let running = tool.output(args, process_cancel.clone());
        tokio::pin!(running);
        let monitor = monitor_output(output.clone(), input.directory.clone(), cancel.clone());
        tokio::select! {
            value = &mut running => { value?; },
            error = monitor => {
                process_cancel.cancel();
                let _ = running.await;
                error?;
            }
        }
        let destination = input.directory.path().join("decoded.zip");
        let target = destination.clone();
        let directory = input.directory.clone();
        let token = cancel.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let _guard = directory;
            packing::pack(&output, &target, &token)
        });
        let (files, unpacked_size) = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::Cancelled),
            value = tokio::time::timeout(TIMEOUT,worker) => value.map_err(|_| {cancel.cancel(); Error::Timeout})?.map_err(|e| Error::Dependency(e.to_string()))??,
        };
        let file = tokio::fs::File::open(destination)
            .await
            .map_err(|e| Error::Storage(e.to_string()))?;
        let stream = ReaderStream::new(file).map_err(|e| Error::Storage(e.to_string()));
        let artifact = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::Cancelled),
            value = tokio::time::timeout(TIMEOUT,self.artifacts.put("decoded.zip".into(),Box::pin(stream))) => value.unwrap_or(Err(Error::Timeout))?,
        };
        Ok(DecodedPackage {
            source_artifact_id: id.into(),
            artifact,
            files,
            unpacked_size,
        })
    }
    async fn scan_sdks(
        &self,
        id: &str,
        rules: Vec<SdkRule>,
        cancel: CancellationToken,
    ) -> Result<SdkScan> {
        scanning::validate(&rules)?;
        let input = materialize(self.artifacts.as_ref(), id, &[".zip"], cancel.clone()).await?;
        let token = cancel.clone();
        let id = id.to_owned();
        let worker = tokio::task::spawn_blocking(move || {
            let _guard = input.directory;
            scanning::scan(&input.path, &id, rules, &token)
        });
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(Error::Cancelled),
            value = tokio::time::timeout(TIMEOUT,worker) => value.map_err(|_| {cancel.cancel(); Error::Timeout})?.map_err(|e| Error::Dependency(e.to_string()))?,
        }
    }
}
#[cfg(test)]
mod tests;
