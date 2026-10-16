//! 市场来源只由部署配置提供，宿主管理修订优先于旧环境与本地默认值。
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    ffi::OsString,
    path::{Path, PathBuf},
};
use tokio::io::AsyncReadExt;

const LIMIT: usize = 65_536;
const DEFAULT_SOURCE: &str = "http://127.0.0.1:7040";

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Source {
    pub name: String,
    pub url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    format_version: u32,
    sources: Vec<Source>,
}

fn validate(mut sources: Vec<Source>) -> Result<Vec<Source>, String> {
    if sources.is_empty() || sources.len() > 64 {
        return Err("市场来源须为1至64项".into());
    }
    let mut seen = BTreeSet::new();
    for source in &mut sources {
        if source.name.trim().is_empty()
            || source.name.len() > 128
            || source.name.chars().any(char::is_control)
            || source.url.len() > 2048
        {
            return Err("市场来源名称或地址无效".into());
        }
        let url = reqwest::Url::parse(&source.url).map_err(|_| "市场来源地址无效")?;
        if !["http", "https"].contains(&url.scheme())
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("市场来源须为无凭据、查询与片段的HTTP目录地址".into());
        }
        source.url = url.as_str().trim_end_matches('/').to_owned();
        if !seen.insert(source.url.clone()) {
            return Err("市场来源地址重复".into());
        }
    }
    Ok(sources)
}

fn parse(bytes: &[u8]) -> Result<Vec<Source>, String> {
    if bytes.len() > LIMIT {
        return Err("市场来源配置超过65536字节".into());
    }
    let config: Config = serde_json::from_slice(bytes).map_err(|_| "市场来源配置格式无效")?;
    if config.format_version != 1 {
        return Err("市场来源配置版本须为1".into());
    }
    validate(config.sources)
}

fn path(
    managed: Option<PathBuf>,
    args: &[OsString],
    executable: &Path,
) -> Result<(PathBuf, bool), String> {
    if let Some(path) = managed {
        if !path.is_absolute() {
            return Err("市场来源配置须为绝对路径".into());
        }
        return Ok((path, true));
    }
    let (legacy, explicit) = match args {
        [] => (executable.with_file_name("marketplace.config.json"), false),
        [flag, file] if flag == "--config" => (PathBuf::from(file), true),
        _ => return Err("市场插件只接受 --config 绝对路径".into()),
    };
    let (path, explicit) = (legacy, explicit);
    if !path.is_absolute() {
        return Err("市场来源配置须为绝对路径".into());
    }
    Ok((path, explicit))
}

pub(crate) async fn sources() -> Result<Vec<Source>, String> {
    let executable = std::env::current_exe().map_err(|_| "市场插件入口无法定位")?;
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let (path, explicit) = path(
        apk_plugin_sdk::configuration::managed_config_path(),
        &args,
        &executable,
    )?;
    match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata) => {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > LIMIT as u64
            {
                return Err("市场来源配置须为65536字节以内的普通文件".into());
            }
            let mut bytes = Vec::new();
            tokio::fs::File::open(path)
                .await
                .map_err(|_| "市场来源配置无法打开")?
                .take((LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| "市场来源配置无法读取")?;
            parse(&bytes)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !explicit => {
            if let Some(raw) = std::env::var_os("DEVICEFORGE_MARKETPLACE_SOURCES") {
                let raw = raw.to_str().ok_or("市场来源环境配置须为UTF-8")?;
                if raw.len() > LIMIT {
                    return Err("市场来源环境配置超限".into());
                }
                let entries: Vec<Source> =
                    serde_json::from_str(raw).map_err(|_| "市场来源环境配置无效")?;
                if !entries.is_empty() {
                    return validate(entries);
                }
            }
            validate(vec![Source {
                name: "本地默认市场".into(),
                url: DEFAULT_SOURCE.into(),
            }])
        }
        Err(_) => Err("市场来源配置无法读取".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sources_reject_unknown_fields_invalid_urls_and_duplicate_addresses() {
        for value in [
            json!({"format_version":2,"sources":[]}),
            json!({"format_version":1,"sources":[],"unknown":true}),
            json!({"format_version":1,"sources":[{"name":"本地","url":"file:///tmp"}]}),
            json!({"format_version":1,"sources":[{"name":"本地","url":"https://user:pass@example.com"}]}),
            json!({"format_version":1,"sources":[{"name":"本地","url":"https://example.com?q=1"}]}),
            json!({"format_version":1,"sources":[{"name":"甲","url":"https://example.com/"},{"name":"乙","url":"https://example.com"}]}),
        ] {
            assert!(parse(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        let sources = parse(
            br#"{"format_version":1,"sources":[{"name":"local","url":"http://127.0.0.1:7040/"}]}"#,
        )
        .unwrap();
        assert_eq!(sources[0].url, DEFAULT_SOURCE);
    }

    #[test]
    fn managed_revision_wins_over_valid_legacy_argument_and_missing_is_explicit() {
        let root = std::env::temp_dir();
        let managed = root.join("revision.json");
        let legacy = root.join("legacy.json");
        let args = [OsString::from("--config"), legacy.into_os_string()];
        let (selected, explicit) =
            path(Some(managed.clone()), &args, &root.join("plugin.exe")).unwrap();
        assert_eq!(selected, managed);
        assert!(explicit);
        assert!(
            path(
                Some(PathBuf::from("relative.json")),
                &[],
                &root.join("plugin.exe")
            )
            .is_err()
        );
    }
}
