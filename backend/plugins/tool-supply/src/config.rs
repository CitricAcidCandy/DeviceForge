//! 旁置配置属于部署者，普通操作输入不能改写来源或安装根目录。
use crate::{
    budget::Budget,
    error::{Error, Result},
};
use serde::Deserialize;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub(crate) const MANIFEST_LIMIT: u64 = 1024 * 1024;
#[derive(Clone)]
pub(crate) enum Source {
    Url(String),
    Local(PathBuf),
}
#[derive(Clone)]
pub(crate) struct Config {
    pub source: Source,
    pub manifest_cache_enabled: bool,
    pub root: PathBuf,
    pub allow_http: bool,
    pub download_limit: u64,
    pub extracted_limit: u64,
    pub file_limit: usize,
    pub repository: Option<apk_plugin_sdk::resources::ManagedRepository>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Raw {
    manifest_url: Option<String>,
    local_manifest: Option<PathBuf>,
    #[serde(default = "cache_enabled")]
    manifest_cache_enabled: bool,
    install_root: Option<PathBuf>,
    #[serde(default)]
    repository_mode: RepositoryMode,
    #[serde(default)]
    allow_http: bool,
    #[serde(default = "download_limit")]
    download_limit_bytes: u64,
    #[serde(default = "extracted_limit")]
    extracted_limit_bytes: u64,
    #[serde(default = "file_limit")]
    file_limit: usize,
}
#[derive(Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RepositoryMode {
    #[default]
    Custom,
    Managed,
}
fn cache_enabled() -> bool {
    true
}
fn download_limit() -> u64 {
    512 * 1024 * 1024
}
fn extracted_limit() -> u64 {
    1024 * 1024 * 1024
}
fn file_limit() -> usize {
    10_000
}

pub(crate) fn read_bounded(path: &Path, limit: u64, budget: &Budget) -> Result<Vec<u8>> {
    budget.check()?;
    let metadata = fs::symlink_metadata(path).map_err(|_| Error::Io("读取配置或清单失败"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(Error::Invalid("配置、清单或状态必须是普通文件"));
    }
    if metadata.len() > limit {
        return Err(Error::TooLarge);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| Error::Io("打开配置或清单失败"))?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Io("读取配置或清单失败"))?;
    if bytes.len() as u64 > limit {
        return Err(Error::TooLarge);
    }
    budget.check()?;
    Ok(bytes)
}
impl Config {
    pub fn read(budget: &Budget) -> Result<Self> {
        let executable = std::env::current_exe().map_err(|_| Error::Io("定位插件部署目录失败"))?;
        let path = executable
            .parent()
            .ok_or(Error::Invalid("插件部署目录不存在"))?
            .join("tool-supply.config.json");
        match apk_plugin_sdk::configuration::managed_config_path() {
            Some(managed) => Self::read_with_base(
                &managed,
                path.parent().ok_or(Error::Invalid("插件部署目录不存在"))?,
                budget,
            ),
            None => Self::read_path(&path, budget),
        }
    }
    pub fn read_path(path: &Path, budget: &Budget) -> Result<Self> {
        Self::read_with_base(
            path,
            path.parent().ok_or(Error::Invalid("配置目录不存在"))?,
            budget,
        )
    }
    fn read_with_base(path: &Path, base: &Path, budget: &Budget) -> Result<Self> {
        if !path.is_absolute() || !base.is_absolute() {
            return Err(Error::Invalid("配置与清单基目录须为绝对路径"));
        }
        let bytes = read_bounded(path, 64 * 1024, budget)?;
        let raw: Raw =
            serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("部署配置结构错误"))?;
        let custom_root = if raw.repository_mode == RepositoryMode::Custom {
            let root = raw
                .install_root
                .ok_or(Error::Invalid("自定义仓库必须配置安装根目录"))?;
            if !root.is_absolute()
                || root.to_str().is_none_or(|value| {
                    value.chars().any(char::is_control)
                        || value.split(['/', '\\']).any(|part| part == "..")
                })
            {
                return Err(Error::Invalid("安装根目录必须是无父段的合法绝对路径"));
            }
            Some(root)
        } else {
            None
        };
        if !(1..=2 * 1024 * 1024 * 1024).contains(&raw.download_limit_bytes)
            || !(1..=4 * 1024 * 1024 * 1024).contains(&raw.extracted_limit_bytes)
            || !(1..=100_000).contains(&raw.file_limit)
        {
            return Err(Error::Invalid("部署限额超出允许范围"));
        }
        let source = match (raw.manifest_url, raw.local_manifest) {
            (Some(url), None) => {
                validate_url(&url, raw.allow_http)?;
                Source::Url(url)
            }
            (None, Some(local)) => Source::Local(if local.is_absolute() {
                local
            } else {
                base.join(local)
            }),
            _ => {
                return Err(Error::Invalid(
                    "manifest_url 与 local_manifest 必须恰好配置一个",
                ));
            }
        };
        budget.check()?;
        let repository = if raw.repository_mode == RepositoryMode::Managed {
            Some(
                apk_plugin_sdk::managed_resources()
                    .map_err(|_| Error::Invalid("宿主管理资源描述无效"))?
                    .and_then(|resources| resources.repository)
                    .ok_or(Error::Invalid("宿主未提供共享工具仓库"))?,
            )
        } else {
            None
        };
        let install_root = match &repository {
            Some(descriptor) => {
                let repository = deviceforge_tool_repository::Repository::open(&descriptor.root)
                    .map_err(crate::managed::repository_error)?;
                repository
                    .client_directory(&descriptor.client_id)
                    .map_err(crate::managed::repository_error)?
            }
            None => custom_root.ok_or(Error::Invalid("自定义仓库必须配置安装根目录"))?,
        };
        fs::create_dir_all(&install_root).map_err(|_| Error::Io("创建安装根目录失败"))?;
        let metadata =
            fs::symlink_metadata(&install_root).map_err(|_| Error::Io("检查安装根目录失败"))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(Error::Invalid("安装根目录不能是符号链接"));
        }
        let root = fs::canonicalize(install_root).map_err(|_| Error::Io("解析安装根目录失败"))?;
        Ok(Self {
            source,
            manifest_cache_enabled: raw.manifest_cache_enabled,
            root,
            allow_http: raw.allow_http,
            download_limit: raw.download_limit_bytes,
            extracted_limit: raw.extracted_limit_bytes,
            file_limit: raw.file_limit,
            repository,
        })
    }
}
pub(crate) fn validate_url(value: &str, allow_http: bool) -> Result<()> {
    if value.len() > 4096 {
        return Err(Error::Invalid("下载地址超过 4096 字节"));
    }
    let url = reqwest::Url::parse(value).map_err(|_| Error::Invalid("清单下载地址无效"))?;
    if (url.scheme() != "https" && !(allow_http && url.scheme() == "http"))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::Invalid(
            "下载只允许无凭据的 HTTPS，HTTP 必须由部署者显式启用",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod configuration_tests {
    use super::*;
    use std::time::{Duration, Instant};
    use tokio_util::sync::CancellationToken;

    #[test]
    fn revision_relative_manifest_uses_deployment_base_and_missing_revision_fails() {
        let root = tempfile::tempdir().unwrap();
        let revisions = root.path().join("revisions");
        fs::create_dir(&revisions).unwrap();
        let path = revisions.join("1.json");
        fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "local_manifest":"tool-catalog.json", "install_root":root.path().join("tools")
            }))
            .unwrap(),
        )
        .unwrap();
        let budget = Budget {
            deadline: Instant::now() + Duration::from_secs(5),
            cancel: CancellationToken::new(),
        };
        let config = Config::read_with_base(&path, root.path(), &budget).unwrap();
        assert!(
            matches!(config.source, Source::Local(source) if source == root.path().join("tool-catalog.json"))
        );
        let legacy = Config::read_path(&path, &budget).unwrap();
        assert!(
            matches!(legacy.source, Source::Local(source) if source == revisions.join("tool-catalog.json"))
        );
        fs::remove_file(&path).unwrap();
        assert!(Config::read_with_base(&path, root.path(), &budget).is_err());
    }

    #[test]
    fn custom_repository_requires_an_absolute_root_and_preserves_legacy_mode() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tool-supply.config.json");
        let root = directory.path().join("tools");
        let budget = Budget {
            deadline: Instant::now() + Duration::from_secs(5),
            cancel: CancellationToken::new(),
        };
        let mut value = serde_json::json!({
            "local_manifest":"tool-catalog.json", "repository_mode":"custom"
        });
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(
            Config::read_path(&path, &budget),
            Err(Error::Invalid(_))
        ));
        for invalid in [
            serde_json::Value::Null,
            serde_json::json!(""),
            serde_json::json!("relative/tools"),
            serde_json::json!(root.join("../escape")),
            serde_json::json!(format!("{}\n", root.display())),
        ] {
            value["install_root"] = invalid;
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            assert!(matches!(
                Config::read_path(&path, &budget),
                Err(Error::Invalid(_))
            ));
            assert!(!root.exists());
        }
        value["install_root"] = serde_json::json!(root);
        for legacy in [false, true] {
            if legacy {
                value.as_object_mut().unwrap().remove("repository_mode");
            }
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            let config = Config::read_path(&path, &budget).unwrap();
            assert_eq!(config.root, fs::canonicalize(&root).unwrap());
            assert!(config.repository.is_none());
        }
    }
}
