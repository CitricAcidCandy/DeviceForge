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
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Raw {
    manifest_url: Option<String>,
    local_manifest: Option<PathBuf>,
    #[serde(default = "cache_enabled")]
    manifest_cache_enabled: bool,
    install_root: PathBuf,
    #[serde(default)]
    allow_http: bool,
    #[serde(default = "download_limit")]
    download_limit_bytes: u64,
    #[serde(default = "extracted_limit")]
    extracted_limit_bytes: u64,
    #[serde(default = "file_limit")]
    file_limit: usize,
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
        Self::read_path(&path, budget)
    }
    pub fn read_path(path: &Path, budget: &Budget) -> Result<Self> {
        let bytes = read_bounded(path, 64 * 1024, budget)?;
        let raw: Raw =
            serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("部署配置结构错误"))?;
        if !raw.install_root.is_absolute() {
            return Err(Error::Invalid("安装根目录必须是部署者指定的绝对路径"));
        }
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
                path.parent()
                    .ok_or(Error::Invalid("配置目录不存在"))?
                    .join(local)
            }),
            _ => {
                return Err(Error::Invalid(
                    "manifest_url 与 local_manifest 必须恰好配置一个",
                ));
            }
        };
        budget.check()?;
        fs::create_dir_all(&raw.install_root).map_err(|_| Error::Io("创建安装根目录失败"))?;
        let metadata =
            fs::symlink_metadata(&raw.install_root).map_err(|_| Error::Io("检查安装根目录失败"))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(Error::Invalid("安装根目录不能是符号链接"));
        }
        let root =
            fs::canonicalize(raw.install_root).map_err(|_| Error::Io("解析安装根目录失败"))?;
        Ok(Self {
            source,
            manifest_cache_enabled: raw.manifest_cache_enabled,
            root,
            allow_http: raw.allow_http,
            download_limit: raw.download_limit_bytes,
            extracted_limit: raw.extracted_limit_bytes,
            file_limit: raw.file_limit,
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
