//! 异步流式获取；每个准备事务共享一次绝对期限，逐块校验精确大小与摘要。
use super::{FilePluginInstallations, Stage, StageLease, archive, content, paths};
use apk_domain::{Error, Result, artifacts::ArtifactStream, plugin_installations::*};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncWriteExt;

pub(super) struct ReleaseInput {
    pub stage: Stage,
    pub manifest: ReleaseManifest,
    pub revision: String,
    pub origin: Origin,
    pub deadline: tokio::time::Instant,
}
pub(super) enum Origin {
    Market(reqwest::Url),
    Offline(PathBuf),
}

pub(super) fn url(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value).map_err(|_| Error::Invalid("市场发布 URL 无效".into()))?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::Invalid(
            "市场 URL 仅接受无凭据 HTTP/HTTPS 地址".into(),
        ));
    }
    Ok(url)
}

async fn stream(
    store: &FilePluginInstallations,
    url: reqwest::Url,
    limit: u64,
    deadline: tokio::time::Instant,
) -> Result<ArtifactStream> {
    let response = tokio::time::timeout_at(deadline, store.client.get(url).send())
        .await
        .map_err(|_| Error::Timeout)?
        .map_err(|_| Error::Dependency("发布资源请求失败".into()))?;
    if !response.status().is_success() {
        return Err(Error::Dependency("发布资源返回非成功状态".into()));
    }
    if response.content_length().is_some_and(|size| size > limit) {
        return Err(Error::TooLarge);
    }
    Ok(Box::pin(response.bytes_stream().map(|chunk| {
        chunk.map_err(|_| Error::Dependency("发布资源流读取失败".into()))
    })))
}

async fn save(
    mut stream: ArtifactStream,
    path: &Path,
    limit: u64,
    expected: Option<(u64, &str)>,
    deadline: tokio::time::Instant,
    progress: Option<(&dyn apk_domain::ProgressReporter, &str)>,
) -> Result<()> {
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
        .map_err(|_| Error::Storage("发布下载暂存失败".into()))?;
    let mut total = 0u64;
    let mut digest = Sha256::new();
    while let Some(chunk) = tokio::time::timeout_at(deadline, stream.next())
        .await
        .map_err(|_| Error::Timeout)?
    {
        let chunk = chunk?;
        total = total
            .checked_add(chunk.len() as u64)
            .filter(|size| *size <= limit && expected.is_none_or(|(expected, _)| *size <= expected))
            .ok_or(Error::TooLarge)?;
        digest.update(&chunk);
        tokio::time::timeout_at(deadline, file.write_all(&chunk))
            .await
            .map_err(|_| Error::Timeout)?
            .map_err(|_| Error::Storage("发布下载写入失败".into()))?;
        if let Some((reporter, id)) = progress {
            tokio::time::timeout_at(
                deadline,
                reporter.report(apk_domain::JobProgress {
                    stage: apk_domain::JobStage::Downloading,
                    resource_id: Some(id.into()),
                    completed_bytes: total,
                    total_bytes: expected.map(|(size, _)| size),
                }),
            )
            .await
            .map_err(|_| Error::Timeout)??;
        }
    }
    file.sync_all()
        .await
        .map_err(|_| Error::Storage("发布下载刷新失败".into()))?;
    if expected
        .is_some_and(|(size, sha)| size != total || sha != format!("{:x}", digest.finalize()))
    {
        return Err(Error::Invalid("发布资源大小或 SHA-256 不匹配".into()));
    }
    Ok(())
}

pub(super) async fn input(
    store: &FilePluginInstallations,
    source: InstallSource,
) -> Result<ReleaseInput> {
    let permit = store
        .installations
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::Conflict("插件安装准备并发已满".into()))?;
    let directory = store
        .work(|store| {
            tempfile::Builder::new()
                .prefix("release-")
                .tempdir_in(store.root.join("installations/staging"))
                .map_err(|_| Error::Storage("发布暂存目录创建失败".into()))
        })
        .await?;
    let stage = Stage(std::sync::Arc::new(StageLease {
        directory: Some(directory),
        permit: Some(permit),
    }));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
    let manifest_path = stage.path().join("release.json");
    let (origin, identity) = match source {
        InstallSource::Market {
            source_url,
            release_id,
            version,
            manifest_sha256,
        } => {
            apk_domain::plugins::plugin_id(&release_id)?;
            validate_release_digest(&manifest_sha256)?;
            let url = url(&source_url)?;
            store.validate_market_url(&url)?;
            save(
                stream(store, url.clone(), RELEASE_MANIFEST_LIMIT as u64, deadline).await?,
                &manifest_path,
                RELEASE_MANIFEST_LIMIT as u64,
                None,
                deadline,
                None,
            )
            .await?;
            (
                Origin::Market(url),
                Some((release_id, version, manifest_sha256)),
            )
        }
        InstallSource::Offline { artifact_id } => {
            let (artifact, bytes) =
                tokio::time::timeout_at(deadline, store.artifacts.download(&artifact_id))
                    .await
                    .map_err(|_| Error::Timeout)??;
            let upload = stage.path().join("offline.zip");
            save(
                bytes,
                &upload,
                RELEASE_OFFLINE_LIMIT,
                Some((artifact.size, &artifact.sha256)),
                deadline,
                None,
            )
            .await?;
            let unpacked = stage.path().join("offline");
            let unpacked_copy = unpacked.clone();
            stage
                .work(store, move |_| {
                    std::fs::create_dir(&unpacked_copy)
                        .map_err(|_| Error::Storage("离线发布展开目录创建失败".into()))?;
                    archive::extract(&upload, &unpacked_copy, ResourceFormat::Zip, false)
                })
                .await?;
            (Origin::Offline(unpacked), None)
        }
    };
    let root_manifest = match &origin {
        Origin::Market(_) => manifest_path,
        Origin::Offline(root) => root.join("release.json"),
    };
    let (manifest, revision) = stage
        .work(store, move |_| {
            let stamp = content::hash(&root_manifest, RELEASE_MANIFEST_LIMIT as u64)?;
            let manifest: ReleaseManifest = paths::read(&root_manifest, RELEASE_MANIFEST_LIMIT)?;
            manifest.validate()?;
            if identity.is_some_and(|(id, version, sha)| {
                id != manifest.id || version != manifest.version || sha != stamp.sha256
            }) {
                return Err(Error::Invalid(
                    "发布清单身份、版本或 SHA-256 与市场条目不符".into(),
                ));
            }
            Ok((manifest, stamp.sha256))
        })
        .await?;
    Ok(ReleaseInput {
        stage,
        manifest,
        revision,
        origin,
        deadline,
    })
}

pub(super) async fn resource(
    store: &FilePluginInstallations,
    input: &ReleaseInput,
    index: usize,
    path: &str,
    size: u64,
    sha256: &str,
    progress: std::sync::Arc<dyn apk_domain::ProgressReporter>,
) -> Result<PathBuf> {
    // 准备并发最多两项；共用异步锁并在取得锁后复查缓存，不建立无界摘要表。
    let download = tokio::time::timeout_at(
        input.deadline,
        store.resource_downloads.clone().lock_owned(),
    )
    .await
    .map_err(|_| Error::Timeout)?;
    if tokio::time::Instant::now() >= input.deadline {
        return Err(Error::Timeout);
    }
    let cached = cached(store, &input.stage, sha256, size).await?;
    if let Some(path) = cached {
        return Ok(path);
    }
    let destination = input.stage.path().join(format!("download-{index}"));
    match &input.origin {
        Origin::Market(base) => {
            let target = base
                .join(path)
                .map_err(|_| Error::Invalid("资源相对 URL 无效".into()))?;
            if target.origin() != base.origin() {
                return Err(Error::Invalid("发布资源必须与清单同源".into()));
            }
            store.validate_market_url(&target)?;
            save(
                stream(store, target, size, input.deadline).await?,
                &destination,
                size,
                Some((size, sha256)),
                input.deadline,
                Some((progress.as_ref(), sha256)),
            )
            .await?;
        }
        Origin::Offline(root) => {
            let offline_root = root.clone();
            let relative = path.to_owned();
            let target = destination.clone();
            let expected = sha256.to_owned();
            input
                .stage
                .work(store, move |_| {
                    let source = paths::existing(&offline_root, &relative)?;
                    let stamp = content::hash(&source, size)?;
                    if stamp.size != size || stamp.sha256 != expected {
                        return Err(Error::Invalid("离线资源大小或 SHA-256 不匹配".into()));
                    }
                    std::fs::copy(source, target)
                        .map_err(|_| Error::Storage("离线资源暂存失败".into()))?;
                    Ok(())
                })
                .await?;
        }
    }
    let digest = sha256.to_owned();
    input
        .stage
        .work(store, move |store| {
            // 发布工作可能在外层等待被取消后继续，锁随实际文件工作结束才释放。
            let _download = download;
            let cached = store.root.join("installations/resources").join(digest);
            if cached.exists() {
                let actual = content::hash(&cached, size)?;
                if actual.size != size
                    || cached.file_name().and_then(|name| name.to_str())
                        != Some(actual.sha256.as_str())
                {
                    return Err(Error::Invalid("下载缓存校验不符".into()));
                }
            } else {
                std::fs::rename(destination, &cached)
                    .map_err(|_| Error::Storage("下载缓存发布失败".into()))?;
            }
            Ok(cached)
        })
        .await
}

pub(super) async fn cached(
    store: &FilePluginInstallations,
    stage: &Stage,
    sha256: &str,
    size: u64,
) -> Result<Option<PathBuf>> {
    let digest = sha256.to_owned();
    stage
        .work(store, move |store| {
            let cached = store.root.join("installations/resources").join(&digest);
            if !cached.exists() {
                return Ok(None);
            }
            let stamp = content::hash(&cached, size)?;
            if stamp.size != size || stamp.sha256 != digest {
                return Err(Error::Invalid("下载缓存大小或摘要不符".into()));
            }
            Ok(Some(cached))
        })
        .await
}
