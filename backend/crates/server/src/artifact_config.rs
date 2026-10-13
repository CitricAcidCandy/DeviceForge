use apk_domain::artifacts::{ArtifactStoreConfig, DEFAULT_ARTIFACT_MAX_SIZE};

pub fn from_environment() -> Result<ArtifactStoreConfig, String> {
    let max_size = parse_bytes("APK_ARTIFACT_MAX_SIZE", DEFAULT_ARTIFACT_MAX_SIZE)?;
    let max_total_bytes = parse_bytes(
        "APK_ARTIFACT_MAX_TOTAL_BYTES",
        apk_domain::artifacts::DEFAULT_ARTIFACT_MAX_TOTAL_BYTES,
    )?;
    let retention_seconds = match std::env::var("APK_ARTIFACT_RETENTION_SECONDS") {
        Ok(value) if !value.trim().is_empty() => {
            Some(parse_integer("APK_ARTIFACT_RETENTION_SECONDS", &value)?)
        }
        Ok(_) | Err(std::env::VarError::NotPresent) => None,
        Err(error) => return Err(format!("读取 APK_ARTIFACT_RETENTION_SECONDS 失败: {error}")),
    };
    let config = ArtifactStoreConfig {
        max_size,
        max_total_bytes,
        retention_seconds,
    };
    config.validate().map_err(|error| error.to_string())?;
    Ok(config)
}

fn parse_bytes(name: &str, default: u64) -> Result<u64, String> {
    match std::env::var(name) {
        Ok(value) => parse_integer(name, &value),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(format!("读取 {name} 失败: {error}")),
    }
}

fn parse_integer(name: &str, value: &str) -> Result<u64, String> {
    value
        .trim()
        .parse::<u64>()
        .map_err(|_| format!("{name} 必须是非负整数"))
}

#[cfg(test)]
mod tests {
    use super::parse_integer;

    #[test]
    fn parses_non_negative_integer_without_accepting_garbage() {
        assert_eq!(parse_integer("TEST", " 42 ").unwrap(), 42);
        for value in ["", "-1", "1.5", "unlimited"] {
            assert!(parse_integer("TEST", value).is_err());
        }
    }
}
