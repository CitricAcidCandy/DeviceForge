//! 市场优先、官方 HTTPS 兜底；下载与解包完成后才提交不可变仓库。
use super::{
    FilePluginDependencies, archive, check,
    discovery::{Candidate, probe},
    files,
    preparation::Preparation,
    state::Selection,
};
use apk_domain::{Error, Result, plugin_dependencies::*};
use deviceforge_tool_repository::{Repository, ToolKey};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

enum AttemptError {
    Fallback(Error),
    Fatal(Error),
}

impl From<Error> for AttemptError {
    fn from(error: Error) -> Self {
        Self::Fatal(error)
    }
}

fn network(error: reqwest::Error) -> AttemptError {
    if !error.is_redirect() && (error.is_connect() || error.is_timeout() || error.is_body()) {
        AttemptError::Fallback(Error::Dependency("依赖来源网络不可用".into()))
    } else {
        AttemptError::Fatal(Error::Dependency("依赖来源请求或重定向无效".into()))
    }
}

fn url(source: &DependencySource) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(&source.url)
        .map_err(|_| Error::Invalid("依赖来源须提供已解析的完整 URL".into()))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || (source.kind == SourceKind::Official && url.scheme() != "https")
        || !matches!(url.scheme(), "https" | "http")
    {
        return Err(Error::Invalid("依赖来源协议或身份部分无效".into()));
    }
    Ok(url)
}

async fn fetch(
    client: &reqwest::Client,
    source: &DependencySource,
    destination: &Path,
    cancel: &CancellationToken,
    deadline: Instant,
) -> std::result::Result<(), AttemptError> {
    let network_deadline = std::cmp::min(deadline, Instant::now() + Duration::from_secs(30));
    let response = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(Error::Cancelled.into()),
        _ = tokio::time::sleep_until(network_deadline.into()) => return Err(if Instant::now() >= deadline { Error::Timeout.into() } else { AttemptError::Fallback(Error::Dependency("依赖来源网络等待超时".into())) }),
        response = client.get(url(source)?).send() => response.map_err(network)?,
    };
    if !response.status().is_success() {
        return Err(
            if matches!(
                response.status().as_u16(),
                404 | 410 | 408 | 502 | 503 | 504
            ) {
                AttemptError::Fallback(Error::Dependency("依赖来源资源不可用".into()))
            } else {
                AttemptError::Fatal(Error::Dependency("依赖来源拒绝下载".into()))
            },
        );
    }
    if response
        .content_length()
        .is_some_and(|length| length != source.size)
    {
        return Err(Error::Dependency("依赖来源内容长度不匹配".into()).into());
    }
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut output = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(Error::Cancelled.into()),
        _ = tokio::time::sleep_until(deadline.into()) => return Err(Error::Timeout.into()),
        file = options.open(destination) => file.map_err(files::io)?,
    };
    let mut stream = response.bytes_stream();
    let mut hash = Sha256::new();
    let mut size = 0u64;
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::Cancelled.into()),
            _ = tokio::time::sleep_until(network_deadline.into()) => return Err(if Instant::now() >= deadline { Error::Timeout.into() } else { AttemptError::Fallback(Error::Dependency("依赖来源网络等待超时".into())) }),
            next = stream.next() => next,
        };
        let Some(bytes) = next else {
            break;
        };
        let bytes = bytes.map_err(network)?;
        size = size
            .checked_add(bytes.len() as u64)
            .filter(|size| *size <= source.size)
            .ok_or(Error::TooLarge)?;
        hash.update(&bytes);
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::Cancelled.into()),
            _ = tokio::time::sleep_until(deadline.into()) => return Err(Error::Timeout.into()),
            result = output.write_all(&bytes) => result.map_err(files::io)?,
        }
    }
    if size != source.size || format!("{:x}", hash.finalize()) != source.sha256 {
        return Err(Error::Dependency("依赖下载长度或 SHA-256 校验失败".into()).into());
    }
    tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(Error::Cancelled.into()),
        _ = tokio::time::sleep_until(deadline.into()) => return Err(Error::Timeout.into()),
        result = output.sync_all() => result.map_err(files::io)?,
    }
    check(cancel, deadline).map_err(Into::into)
}

impl FilePluginDependencies {
    pub(super) async fn download_dependency(
        &self,
        dependency: &Dependency,
        preparation: &mut Preparation,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> Result<Selection> {
        let mut sources: Vec<_> = dependency
            .sources
            .iter()
            .filter(|source| source.platform == Repository::platform() || source.platform == "any")
            .cloned()
            .collect();
        sources.sort_by_key(|source| {
            if source.kind == SourceKind::Market {
                0
            } else {
                1
            }
        });
        if sources.is_empty() {
            return Err(Error::Dependency("依赖没有当前平台可安装来源".into()));
        }
        let mut failure = Error::Dependency("依赖来源均不可用".into());
        for source in sources {
            check(&cancel, deadline)?;
            let result = self
                .download_source(dependency, source, preparation, cancel.clone(), deadline)
                .await;
            match result {
                Ok(selection) => return Ok(selection),
                Err(AttemptError::Fatal(error)) => return Err(error),
                Err(AttemptError::Fallback(error)) => failure = error,
            }
        }
        Err(failure)
    }

    async fn download_source(
        &self,
        dependency: &Dependency,
        source: DependencySource,
        preparation: &mut Preparation,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> std::result::Result<Selection, AttemptError> {
        let stage = Arc::new(
            self.work(|store| store.repository.stage().map_err(super::repository_error))
                .await?,
        );
        let archive = stage.path().join("download");
        let cached = self
            .root
            .join("installations/resources")
            .join(&source.sha256);
        let copied = if cached.is_file() {
            let target = archive.clone();
            let definition = source.clone();
            let copy_cancel = cancel.clone();
            self.work(move |_| {
                use std::io::{Read, Write};
                let mut input = std::fs::File::open(files::file(&cached)?).map_err(files::io)?;
                let mut output = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(target)
                    .map_err(files::io)?;
                let mut buffer = [0u8; 65536];
                let mut hash = Sha256::new();
                let mut size = 0u64;
                loop {
                    check(&copy_cancel, deadline)?;
                    let count = input.read(&mut buffer).map_err(files::io)?;
                    if count == 0 {
                        break;
                    }
                    size = size
                        .checked_add(count as u64)
                        .filter(|size| *size <= definition.size)
                        .ok_or(Error::TooLarge)?;
                    hash.update(&buffer[..count]);
                    output.write_all(&buffer[..count]).map_err(files::io)?;
                }
                if size != definition.size || format!("{:x}", hash.finalize()) != definition.sha256
                {
                    return Err(Error::Dependency("依赖离线缓存大小或摘要不符".into()));
                }
                output.sync_all().map_err(files::io)?;
                Ok(true)
            })
            .await?
        } else {
            false
        };
        if !copied {
            if reqwest::Url::parse(&source.url).is_err() {
                return Err(AttemptError::Fallback(Error::Dependency(
                    "离线包未附带依赖资源，且没有可用市场地址".into(),
                )));
            }
            fetch(&self.client, &source, &archive, &cancel, deadline).await?;
        }
        let payload = stage.path().join("payload");
        let extract_payload = payload.clone();
        let extract_source = source.clone();
        let extract_cancel = cancel.clone();
        let extract_stage = stage.clone();
        self.work(move |_| {
            let _stage = extract_stage;
            archive::extract(
                &archive,
                &extract_payload,
                &extract_source,
                &extract_cancel,
                deadline,
            )
        })
        .await?;
        let entries: BTreeMap<_, _> = source
            .entries
            .iter()
            .map(|(entry, relative)| (entry.clone(), payload.join(relative)))
            .collect();
        let selection = probe(
            dependency,
            Candidate {
                selection: Selection {
                    origin: DependencyOrigin::Shared,
                    version: source.version.clone(),
                    entries,
                    key: None,
                },
                lease: None,
                stage: Some(stage.clone()),
            },
            cancel.clone(),
            deadline,
        )
        .await?;
        if selection.version != source.version {
            return Err(Error::Dependency("依赖实际版本与下载来源固定版本不一致".into()).into());
        }
        let key = ToolKey {
            id: dependency.id.clone(),
            version: format!("{}+dep.{}", source.version, &source.sha256[..12]),
            platform: Repository::platform(),
            sha256: source.sha256.clone(),
        };
        let commit_cancel = cancel.clone();
        let commit_key = key.clone();
        let commit_stage = stage.clone();
        let runtime_version = selection.version.clone();
        let stable_entries = source.entries.clone();
        let owner = preparation.owner.clone();
        let prepared_keys = preparation.with_key(&key);
        let commit_keys = prepared_keys.clone();
        let final_root = self
            .work(move |store| {
                let _stage = commit_stage;
                check(&commit_cancel, deadline)?;
                let writer = store.repository.write().map_err(super::repository_error)?;
                let check = || super::repository_check(&commit_cancel, deadline);
                let path = writer
                    .publish(&commit_key, &payload, &check)
                    .map_err(super::repository_error)?;
                writer
                    .register_tool(&commit_key, &runtime_version, &stable_entries, &check)
                    .map_err(super::repository_error)?;
                Preparation::retain_published(&writer, &owner, &commit_keys)?;
                Ok(path)
            })
            .await?;
        preparation.keys = prepared_keys;
        Ok(Selection {
            key: Some(key),
            entries: source
                .entries
                .iter()
                .map(|(entry, relative)| (entry.clone(), final_root.join(relative)))
                .collect(),
            ..selection
        })
    }
}

fn redirect_allowed(url: &reqwest::Url, previous: usize) -> bool {
    previous < 5
        && url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.host_str().is_some()
}

pub(super) fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if !redirect_allowed(attempt.url(), attempt.previous().len()) {
                attempt.error("依赖来源重定向超限或不是 HTTPS")
            } else {
                attempt.follow()
            }
        }))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
}

pub(super) fn client() -> Result<reqwest::Client> {
    client_builder()
        .build()
        .map_err(|_| Error::Storage("依赖下载客户端初始化失败".into()))
}

#[cfg(test)]
#[path = "download_tests.rs"]
mod tests;
