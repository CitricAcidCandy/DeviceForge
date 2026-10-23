//! 安装器使用部署者配置的市场目录；来源配置不依赖市场插件是否安装。
use apk_domain::{Error, Result};
use serde::Deserialize;
use std::path::Path;
use tokio::io::AsyncReadExt;

const LIMIT: usize = 65_536;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    name: String,
    url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    #[serde(default = "version")]
    format_version: u32,
    sources: Vec<Source>,
}

fn version() -> u32 {
    1
}

fn sources(entries: Vec<Source>) -> Result<Vec<String>> {
    if entries.is_empty() || entries.len() > 64 {
        return Err(Error::Invalid("市场来源须为1至64项".into()));
    }
    let mut urls = std::collections::BTreeSet::new();
    for entry in entries {
        if entry.name.trim().is_empty()
            || entry.name.len() > 128
            || entry.name.chars().any(char::is_control)
            || entry.url.len() > 2048
            || entry.url.contains(['?', '#'])
        {
            return Err(Error::Invalid("市场来源名称或目录地址无效".into()));
        }
        // URL 的协议、凭据和目录边界由共享仓库统一校验。
        if !urls.insert(entry.url.trim_end_matches('/').to_owned()) {
            return Err(Error::Invalid("市场来源目录重复".into()));
        }
    }
    Ok(urls.into_iter().collect())
}

async fn read(path: &Path) -> Result<Vec<String>> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| Error::Storage("市场来源配置无法读取".into()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > LIMIT as u64 {
        return Err(Error::Invalid(
            "市场来源配置须为65536字节以内的普通文件".into(),
        ));
    }
    let mut bytes = Vec::new();
    tokio::fs::File::open(path)
        .await
        .map_err(|_| Error::Storage("市场来源配置无法打开".into()))?
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| Error::Storage("市场来源配置读取失败".into()))?;
    if bytes.len() > LIMIT {
        return Err(Error::TooLarge);
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let config: Configuration =
        serde_json::from_slice(bytes).map_err(|_| Error::Invalid("市场来源配置格式无效".into()))?;
    if config.format_version != 1 {
        return Err(Error::Invalid("市场来源配置版本须为1".into()));
    }
    sources(config.sources)
}

pub(crate) async fn from_environment() -> Result<Vec<String>> {
    if let Some(path) = std::env::var_os("DEVICEFORGE_MARKETPLACE_CONFIG") {
        if path.is_empty() {
            return Err(Error::Invalid("市场来源配置路径不能为空".into()));
        }
        return read(Path::new(&path)).await;
    }
    if let Some(raw) = std::env::var_os("DEVICEFORGE_MARKETPLACE_SOURCES") {
        let raw = raw
            .to_str()
            .ok_or_else(|| Error::Invalid("市场来源环境配置须为UTF-8".into()))?;
        if raw.len() > LIMIT {
            return Err(Error::TooLarge);
        }
        let entries = serde_json::from_str(raw)
            .map_err(|_| Error::Invalid("市场来源环境配置格式无效".into()))?;
        return sources(entries);
    }
    Ok(vec!["http://127.0.0.1:7040".into()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn deployment_file_supports_cli_format_and_rejects_invalid_version_and_duplicates() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("sources.json");
        tokio::fs::write(
            &path,
            br#"{"sources":[{"name":"local","url":"http://127.0.0.1:7040/sub/"}]}"#,
        )
        .await
        .unwrap();
        assert_eq!(read(&path).await.unwrap(), ["http://127.0.0.1:7040/sub"]);
        for raw in [
            r#"{"format_version":2,"sources":[]}"#,
            r#"{"sources":[{"name":"a","url":"https://example.com/"},{"name":"b","url":"https://example.com"}]}"#,
            r#"{"sources":[{"name":"a","url":"https://example.com?a=1"}]}"#,
        ] {
            tokio::fs::write(&path, raw).await.unwrap();
            assert!(read(&path).await.is_err());
        }
        tokio::fs::write(&path, vec![b' '; LIMIT + 1])
            .await
            .unwrap();
        assert!(read(&path).await.is_err());
    }
}
