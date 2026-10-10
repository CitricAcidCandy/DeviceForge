//! 部署者静态绑定配置的有界异步读取；规则和模式编译由应用层负责。
use apk_application::operation_aliases::Config;
use apk_domain::{Error, Result};
use std::path::Path;
use tokio::io::AsyncReadExt;

const CONFIG_LIMIT: u64 = 64 * 1024;

pub(crate) async fn from_environment() -> Result<Config> {
    match std::env::var_os("APK_OPERATION_BINDINGS") {
        Some(path) if path.is_empty() => Err(Error::Invalid("操作绑定配置路径不能为空".into())),
        Some(path) => read(Path::new(&path)).await,
        None => Ok(Config::default()),
    }
}

async fn read(path: &Path) -> Result<Config> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| Error::Storage("操作绑定配置无法读取".into()))?;
    let mut bytes = Vec::new();
    file.take(CONFIG_LIMIT + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| Error::Storage("操作绑定配置读取失败".into()))?;
    if bytes.len() as u64 > CONFIG_LIMIT {
        return Err(Error::TooLarge);
    }
    let config: Config = serde_json::from_slice(&bytes)
        .map_err(|_| Error::Invalid("操作绑定配置 JSON 无效".into()))?;
    config.validate()?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn exact_limit_is_accepted_but_one_extra_byte_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bindings.json");
        let mut bytes = br#"{"format_version":1,"bindings":[]}"#.to_vec();
        bytes.resize(CONFIG_LIMIT as usize, b' ');
        tokio::fs::write(&path, &bytes).await.unwrap();
        assert!(read(&path).await.unwrap().bindings.is_empty());
        bytes.push(b' ');
        tokio::fs::write(&path, &bytes).await.unwrap();
        assert!(matches!(read(&path).await, Err(Error::TooLarge)));
    }

    #[tokio::test]
    async fn malformed_json_unknown_fields_and_unsupported_version_are_invalid() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bindings.json");
        for bytes in [
            "{",
            r#"{"format_version":1,"bindings":[],"unexpected":true}"#,
            r#"{"format_version":3,"bindings":[]}"#,
        ] {
            tokio::fs::write(&path, bytes).await.unwrap();
            assert!(matches!(read(&path).await, Err(Error::Invalid(_))));
        }
    }

    #[tokio::test]
    async fn unreadable_configuration_does_not_expose_deployment_path() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private-deployment-bindings.json");
        let error = read(&path).await.unwrap_err();
        assert!(matches!(error, Error::Storage(_)));
        assert_eq!(error.to_string(), "存储失败：操作绑定配置无法读取");
    }
}
