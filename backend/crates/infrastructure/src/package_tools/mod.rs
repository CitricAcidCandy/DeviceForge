mod manifest;
mod signature;
use crate::{
    artifact_files::{LIMIT, materialize},
    artifacts::validation,
    process,
};
use apk_domain::{
    Error, Result,
    artifacts::ArtifactStore,
    packages::{ExtractedApk, PackageAnalyzer, PackageFormat, PackageManifest, PackageSignature},
};
use async_trait::async_trait;
use futures_util::TryStreamExt;
use std::{sync::Arc, time::Duration};
use tokio_util::{io::ReaderStream, sync::CancellationToken};
const TIMEOUT: Duration = Duration::from_secs(120);

/// 工具入口和固定前缀参数只由部署者提供。
#[derive(Clone)]
pub struct ToolCommand {
    pub executable: String,
    pub prefix: Vec<String>,
}
impl ToolCommand {
    pub fn executable(executable: String) -> Self {
        Self {
            executable,
            prefix: Vec::new(),
        }
    }
    pub fn java_jar(java: String, jar: String) -> Self {
        Self {
            executable: java,
            prefix: vec!["-Xmx256m".into(), "-jar".into(), jar],
        }
    }
    pub(crate) async fn output(
        &self,
        args: Vec<String>,
        cancel: CancellationToken,
    ) -> Result<String> {
        let args: Vec<_> = self.prefix.iter().cloned().chain(args).collect();
        let output = process::run(&self.executable, &args, None, TIMEOUT, cancel, false).await?;
        String::from_utf8(output).map_err(|_| Error::Dependency("工具标准输出不是 UTF-8".into()))
    }
}
pub struct AndroidPackageTools {
    pub artifacts: Arc<dyn ArtifactStore>,
    pub apkanalyzer: ToolCommand,
    pub apksigner: ToolCommand,
    pub bundletool: Option<ToolCommand>,
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
        if let Some(module) = module {
            module_name(module)?;
        }
        let input = materialize(
            self.artifacts.as_ref(),
            id,
            &[".apk", ".aab"],
            cancel.clone(),
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
                .apkanalyzer
                .output(vec!["manifest".into(), "print".into(), path], cancel)
                .await?;
            manifest::parse(id, PackageFormat::Apk, None, xml)
        } else {
            let module = module.unwrap_or("base");
            let tool = self
                .bundletool
                .as_ref()
                .ok_or_else(|| Error::Dependency("部署者尚未配置 APK_BUNDLETOOL_JAR".into()))?;
            let xml = tool
                .output(
                    vec![
                        "dump".into(),
                        "manifest".into(),
                        format!("--bundle={path}"),
                        format!("--module={module}"),
                    ],
                    cancel,
                )
                .await?;
            manifest::parse(id, PackageFormat::Aab, Some(module.into()), xml)
        }
    }
    async fn signature(&self, id: &str, cancel: CancellationToken) -> Result<PackageSignature> {
        let input = materialize(self.artifacts.as_ref(), id, &[".apk"], cancel.clone()).await?;
        let report = self
            .apksigner
            .output(
                vec![
                    "verify".into(),
                    "--verbose".into(),
                    "--print-certs".into(),
                    input.path.to_string_lossy().into_owned(),
                ],
                cancel,
            )
            .await?;
        signature::parse(
            id,
            report.replace(
                input.path.to_string_lossy().as_ref(),
                &input.artifact.filename,
            ),
        )
    }
    async fn extract_apk(
        &self,
        id: &str,
        entry: &str,
        cancel: CancellationToken,
    ) -> Result<ExtractedApk> {
        if entry.len() > 500
            || !entry.to_ascii_lowercase().ends_with(".apk")
            || !validation::safe_entry(entry)
        {
            return Err(Error::Invalid(
                "必须选择 APKS 内不含越界路径的 APK 条目".into(),
            ));
        }
        let input = materialize(self.artifacts.as_ref(), id, &[".apks"], cancel.clone()).await?;
        let _directory = input.directory.clone();
        let destination = input.directory.path().join("extracted.apk");
        let target = destination.clone();
        let name = entry.to_owned();
        let token = cancel.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let _directory = input.directory;
            validation::validate_archive(&input.path)?;
            let mut archive = validation::archive(&input.path)?;
            let matches = (0..archive.len())
                .filter(|index| archive.name_for_index(*index) == Some(name.as_str()))
                .count();
            if matches == 0 {
                return Err(Error::NotFound("APKS 内不存在指定 APK 条目".into()));
            }
            if matches != 1 {
                return Err(Error::Invalid(
                    "APKS 包含同名 APK 条目，无法确定选择".into(),
                ));
            }
            let mut member = archive
                .by_name(&name)
                .map_err(|_| Error::Invalid("APK 条目无法读取".into()))?;
            if member.is_dir() || member.size() > LIMIT {
                return Err(Error::TooLarge);
            }
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)
                .map_err(|e| Error::Storage(e.to_string()))?;
            let mut buffer = [0; 64 * 1024];
            let mut total = 0u64;
            loop {
                if token.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                let count = std::io::Read::read(&mut member, &mut buffer)
                    .map_err(|_| Error::Invalid("APK 条目解压或 CRC 校验失败".into()))?;
                if count == 0 {
                    break;
                }
                total += count as u64;
                if total > LIMIT {
                    return Err(Error::TooLarge);
                }
                std::io::Write::write_all(&mut file, &buffer[..count])
                    .map_err(|e| Error::Storage(e.to_string()))?;
            }
            file.sync_all().map_err(|e| Error::Storage(e.to_string()))?;
            Ok(())
        });
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::Cancelled),
            result = tokio::time::timeout(TIMEOUT, worker) => result.map_err(|_| { cancel.cancel(); Error::Timeout })?.map_err(|e| Error::Dependency(e.to_string()))??,
        }
        let file = tokio::fs::File::open(destination)
            .await
            .map_err(|e| Error::Storage(e.to_string()))?;
        let stream = ReaderStream::new(file).map_err(|e| Error::Storage(e.to_string()));
        let artifact = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::Cancelled),
            value = tokio::time::timeout(TIMEOUT, self.artifacts.put("extracted.apk".into(), Box::pin(stream))) => value.unwrap_or(Err(Error::Timeout))?,
        };
        Ok(ExtractedApk {
            source_artifact_id: id.into(),
            entry: entry.into(),
            artifact,
        })
    }
}
#[cfg(test)]
mod tests;
