//! 清单兼容旧工具更新器的名称、版本、摘要与运行时元数据；安装路径由新部署配置确定。
use crate::{
    budget::Budget,
    cache,
    config::{self, Config, Source},
    error::{Error, Result},
    input::valid_id,
    network,
};
use serde::{Deserialize, Serialize};
use std::{cmp::Ordering, collections::HashSet};

#[derive(Debug)]
pub(crate) enum LoadError {
    SourceUnavailable(Error),
    Hard(Error),
}

impl From<LoadError> for Error {
    fn from(error: LoadError) -> Self {
        match error {
            LoadError::SourceUnavailable(error) | LoadError::Hard(error) => error,
        }
    }
}

#[derive(Debug)]
pub(crate) struct Snapshot {
    pub manifest: Manifest,
    pub manifest_source: &'static str,
    pub manifest_sha256: String,
    pub source_error: Option<String>,
}

impl Snapshot {
    pub fn annotate(&self, mut value: serde_json::Value) -> serde_json::Value {
        let fields = value.as_object_mut().expect("工具业务结果必须是对象");
        fields.insert(
            "manifest_version".into(),
            self.manifest.manifest_version.clone().into(),
        );
        fields.insert("manifest_source".into(), self.manifest_source.into());
        fields.insert(
            "manifest_sha256".into(),
            self.manifest_sha256.clone().into(),
        );
        fields.insert("source_error".into(), serde_json::json!(self.source_error));
        value
    }
}

fn source_failure(error: Error) -> LoadError {
    match error {
        Error::Cancelled | Error::Timeout => LoadError::Hard(error),
        _ => LoadError::SourceUnavailable(error),
    }
}

fn parsed(bytes: &[u8], config: &Config, budget: &Budget) -> Result<Manifest> {
    budget.check()?;
    let manifest: Manifest =
        serde_json::from_slice(bytes).map_err(|_| Error::Invalid("工具清单结构错误"))?;
    manifest.validate(config)?;
    cache::canonical(&manifest)?;
    budget.check()?;
    Ok(manifest)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Manifest {
    #[serde(alias = "manifest_version")]
    pub manifest_version: String,
    #[serde(default)]
    pub generated_at: String,
    #[serde(default)]
    pub min_app_version: Option<String>,
    pub modules: Vec<Module>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Module {
    #[serde(alias = "module_id")]
    pub name: String,
    #[serde(rename = "type", default = "tool")]
    pub kind: String,
    pub version: String,
    #[serde(alias = "download_url")]
    pub url: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub extract_root: Option<String>,
    #[serde(default, alias = "archive_root")]
    pub archive_root: Option<String>,
    #[serde(default = "required")]
    pub required: bool,
    #[serde(default, alias = "entry_file")]
    pub entry_file: Option<String>,
    #[serde(default, alias = "feature_key")]
    pub feature_key: Option<String>,
}
fn tool() -> String {
    "tool".into()
}
fn required() -> bool {
    true
}

pub(crate) fn version_parts(version: &str) -> Result<Vec<u64>> {
    if version.is_empty() || version.len() > 128 {
        return Err(Error::Invalid("版本必须是有界点分数字"));
    }
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() > 8
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(Error::Invalid("版本必须是最多八段点分数字"));
    }
    parts
        .into_iter()
        .map(|part| part.parse().map_err(|_| Error::Invalid("版本数字超出范围")))
        .collect()
}
pub(crate) fn compare_version(left: &str, right: &str) -> Result<Ordering> {
    let left = version_parts(left)?;
    let right = version_parts(right)?;
    for index in 0..left.len().max(right.len()) {
        let ordering = left
            .get(index)
            .unwrap_or(&0)
            .cmp(right.get(index).unwrap_or(&0));
        if ordering != Ordering::Equal {
            return Ok(ordering);
        }
    }
    Ok(Ordering::Equal)
}
impl Manifest {
    pub async fn load(
        config: &Config,
        client: &reqwest::Client,
        budget: &Budget,
    ) -> std::result::Result<Snapshot, LoadError> {
        budget.check().map_err(LoadError::Hard)?;
        let mut source_sha256 = None;
        let live = match &config.source {
            Source::Local(path) => config::read_bounded(path, config::MANIFEST_LIMIT, budget)
                .and_then(|bytes| parsed(&bytes, config, budget))
                .map_err(source_failure),
            Source::Url(url) => {
                // 部署地址策略先于远端阶段；策略拒绝不能借缓存绕过。
                config::validate_url(url, config.allow_http).map_err(LoadError::Hard)?;
                source_sha256 = Some(cache::source_digest(url).map_err(LoadError::Hard)?);
                let bytes = network::manifest(
                    client,
                    url,
                    config.allow_http,
                    config::MANIFEST_LIMIT,
                    budget,
                )
                .await
                .map_err(|error| match error {
                    Error::Dependency(_) | Error::TooLarge => source_failure(error),
                    _ => LoadError::Hard(error),
                });
                bytes.and_then(|bytes| parsed(&bytes, config, budget).map_err(source_failure))
            }
        };
        match live {
            Ok(manifest) => {
                if config.manifest_cache_enabled
                    && let Some(source_sha256) = source_sha256
                {
                    cache::write(config, &source_sha256, &manifest, budget)
                        .map_err(LoadError::Hard)?;
                }
                let manifest_sha256 = cache::digest(&manifest).map_err(LoadError::Hard)?;
                budget.check().map_err(LoadError::Hard)?;
                Ok(Snapshot {
                    manifest,
                    manifest_source: "live",
                    manifest_sha256,
                    source_error: None,
                })
            }
            Err(LoadError::SourceUnavailable(error)) => {
                budget.check().map_err(LoadError::Hard)?;
                if config.manifest_cache_enabled
                    && let Some(source_sha256) = source_sha256
                    && let Some(manifest) =
                        cache::read(config, &source_sha256, budget).map_err(LoadError::Hard)?
                {
                    let manifest_sha256 = cache::digest(&manifest).map_err(LoadError::Hard)?;
                    budget.check().map_err(LoadError::Hard)?;
                    return Ok(Snapshot {
                        manifest,
                        manifest_source: "cache",
                        manifest_sha256,
                        source_error: Some(error.to_string()),
                    });
                }
                Err(LoadError::SourceUnavailable(error))
            }
            Err(error) => Err(error),
        }
    }
    pub fn validate(&self, config: &Config) -> Result<()> {
        if self.manifest_version.is_empty()
            || self.manifest_version.len() > 128
            || self.modules.len() > 128
            || self.generated_at.len() > 128
            || self
                .min_app_version
                .as_ref()
                .is_some_and(|version| version.len() > 128)
        {
            return Err(Error::Invalid("清单版本为空或模块数量超过 128"));
        }
        let mut unique = HashSet::new();
        for module in &self.modules {
            if !valid_id(&module.name) || !unique.insert(&module.name) {
                return Err(Error::Invalid("清单模块 ID 无效或重复"));
            }
            version_parts(&module.version)?;
            if module.sha256.len() != 64
                || !module.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(Error::Invalid("清单 SHA-256 必须为 64 位十六进制"));
            }
            if module.size == 0 || module.size > config.download_limit {
                return Err(Error::TooLarge);
            }
            if module.kind != "tool" && module.kind != "runtime" {
                return Err(Error::Invalid("模块类型只能是 tool 或 runtime"));
            }
            if module
                .feature_key
                .as_ref()
                .is_some_and(|key| key.is_empty() || key.len() > 128)
            {
                return Err(Error::Invalid("模块功能标识必须为 1 至 128 字节"));
            }
            if module.kind == "runtime"
                && (module.entry_file.is_none()
                    || module
                        .feature_key
                        .as_ref()
                        .is_none_or(|key| key.is_empty() || key.len() > 128))
            {
                return Err(Error::Invalid("runtime 缺少入口或功能标识"));
            }
            if let Some(root) = &module.archive_root {
                crate::unpack::relative(root, true)?;
            }
            if let Some(entry) = &module.entry_file {
                crate::unpack::relative(entry, false)?;
            }
            config::validate_url(&module.url, config.allow_http)?;
        }
        Ok(())
    }
    pub fn module(&self, id: &str) -> Result<&Module> {
        self.modules
            .iter()
            .find(|module| module.name == id)
            .ok_or(Error::Invalid("清单不存在指定模块"))
    }
}
