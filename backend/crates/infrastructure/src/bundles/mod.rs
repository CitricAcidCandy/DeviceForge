pub(crate) mod validation;
use crate::{
    artifact_files::{LIMIT, Temporary, materialize},
    package_tools::ToolCommand,
    process,
};
use apk_domain::{
    Error, Result,
    artifacts::ArtifactStore,
    bundles::{BuildApksRequest, BuiltApks, BundleBuilder},
};
use async_trait::async_trait;
use futures_util::TryStreamExt;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio_util::{io::ReaderStream, sync::CancellationToken};
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
}
struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

async fn monitor(path: PathBuf, directory: Arc<Temporary>) -> Result<()> {
    loop {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let _guard = &directory;
        match tokio::fs::symlink_metadata(&path).await {
            Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
                return Err(Error::Invalid("构建输出必须为普通文件".into()));
            }
            Ok(meta) if meta.len() > LIMIT => return Err(Error::TooLarge),
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err(Error::Storage("读取构建输出失败".into())),
        }
    }
}
impl AndroidBundles {
    async fn build_with_timeout(
        &self,
        request: BuildApksRequest,
        cancel: CancellationToken,
        timeout: Duration,
    ) -> Result<BuiltApks> {
        request.validate()?;
        let token = cancel.child_token();
        let _cancel_guard = CancelOnDrop(token.clone());
        let work = async {
            let tool = self
                .bundletool
                .as_ref()
                .ok_or_else(|| Error::Dependency("部署者尚未配置 APK_BUNDLETOOL_JAR".into()))?;
            let signing = self
                .signing
                .as_ref()
                .ok_or_else(|| Error::Dependency("部署者尚未配置 AAB 构建签名文件".into()))?;
            signing.validate()?;
            let input = materialize(
                self.artifacts.as_ref(),
                &request.artifact_id,
                &[".aab"],
                token.clone(),
            )
            .await?;
            let output = input.directory.path().join("built.apks");
            let mut args = tool.prefix.clone();
            args.extend([
                "build-apks".into(),
                format!("--bundle={}", input.path.display()),
                format!("--output={}", output.display()),
                format!("--mode={}", request.mode.argument()),
                "--max-threads=2".into(),
            ]);
            args.extend(signing.arguments());
            // 构建工具的任意诊断可能包含签名信息，依赖失败只向任务返回固定说明。
            let running = process::run_isolated(
                &tool.executable,
                &args,
                timeout,
                token.clone(),
                input.directory.path(),
            );
            tokio::pin!(running);
            tokio::select! {
                biased;
                result = &mut running => {
                    match result {
                        Ok(_) => (),
                        Err(Error::Cancelled) => return Err(Error::Cancelled),
                        Err(Error::Timeout) => return Err(Error::Timeout),
                        Err(_) => return Err(Error::Dependency("AAB 构建工具失败，请由部署者检查工具与签名配置".into())),
                    }
                }
                result = monitor(output.clone(), input.directory.clone()) => { token.cancel(); let _ = running.await; result?; }
            }
            let path = output.clone();
            let directory = input.directory.clone();
            let check_token = token.clone();
            let mode = request.mode;
            let apk_count = tokio::task::spawn_blocking(move || {
                let _guard = directory;
                validation::check(&path, mode, &check_token)
            })
            .await
            .map_err(|_| Error::Dependency("构建产物校验任务失败".into()))??;
            let file = tokio::fs::File::open(&output)
                .await
                .map_err(|_| Error::Storage("读取构建产物失败".into()))?;
            let stream =
                ReaderStream::new(file).map_err(|_| Error::Storage("读取构建产物流失败".into()));
            let artifact = self
                .artifacts
                .put("built.apks".into(), Box::pin(stream))
                .await?;
            Ok(BuiltApks {
                source_artifact_id: request.artifact_id,
                mode,
                artifact,
                apk_count,
                universal_entry: (mode == apk_domain::bundles::BuildMode::Universal)
                    .then(|| "universal.apk".into()),
            })
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(Error::Cancelled),
            value = tokio::time::timeout(timeout, work) => value.unwrap_or(Err(Error::Timeout)),
        }
    }
}
#[async_trait]
impl BundleBuilder for AndroidBundles {
    async fn build(
        &self,
        request: BuildApksRequest,
        cancel: CancellationToken,
    ) -> Result<BuiltApks> {
        self.build_with_timeout(request, cancel, TIMEOUT).await
    }
}
#[cfg(test)]
mod tests;
