//! 七项业务的严格输入；纯预检不读取产物、不访问部署配置。
pub(crate) use deviceforge_android_package_core::apks::DeviceSpec;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ArtifactInput {
    pub artifact_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ManifestInput {
    pub artifact_id: String,
    #[serde(default, deserialize_with = "present_module")]
    pub module: Option<String>,
}

fn present_module<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ExtractInput {
    pub artifact_id: String,
    pub entry: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BuildMode {
    Default,
    Universal,
}

impl<'de> Deserialize<'de> for BuildMode {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "default" => Ok(Self::Default),
            "universal" => Ok(Self::Universal),
            _ => Err(serde::de::Error::custom("构建模式无效")),
        }
    }
}

impl BuildMode {
    pub fn argument(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Universal => "universal",
        }
    }

    pub fn core(self) -> deviceforge_android_package_core::BuildMode {
        match self {
            Self::Default => deviceforge_android_package_core::BuildMode::Default,
            Self::Universal => deviceforge_android_package_core::BuildMode::Universal,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BuildInput {
    pub artifact_id: String,
    pub mode: BuildMode,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SdkRule {
    pub name: String,
    pub package_path: String,
    pub class_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ScanInput {
    pub artifact_id: String,
    pub rules: Vec<SdkRule>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SplitsInput {
    pub artifact_id: String,
    pub device_spec: DeviceSpec,
    #[serde(default)]
    pub modules: Option<Vec<String>>,
    #[serde(default)]
    pub instant: bool,
}

pub(crate) enum Input {
    Manifest(ManifestInput),
    Signature(ArtifactInput),
    Extract(ExtractInput),
    Build(BuildInput),
    Decode(ArtifactInput),
    Scan(ScanInput),
    Splits(SplitsInput),
}

impl Input {
    pub fn parse(operation: &str, value: &Value) -> Result<Self, &'static str> {
        fn decode<T: for<'de> Deserialize<'de>>(value: &Value) -> Result<T, &'static str> {
            serde_json::from_value(value.clone()).map_err(|_| "业务输入字段或类型无效")
        }
        let input = match operation {
            "manifest" => Self::Manifest(decode(value)?),
            "signature" => Self::Signature(decode(value)?),
            "extract_apk" => Self::Extract(decode(value)?),
            "build_apks" => Self::Build(decode(value)?),
            "decode" => Self::Decode(decode(value)?),
            "scan_sdks" => Self::Scan(decode(value)?),
            "extract_splits" => Self::Splits(decode(value)?),
            _ => return Err("未知安卓包操作"),
        };
        input.validate()?;
        Ok(input)
    }

    fn validate(&self) -> Result<(), &'static str> {
        let id = match self {
            Self::Manifest(input) => {
                if input.module.as_ref().is_some_and(|value| {
                    value.is_empty()
                        || value.len() > 80
                        || !value.as_bytes()[0].is_ascii_alphabetic()
                        || !value
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                }) {
                    return Err("AAB 模块名称无效");
                }
                &input.artifact_id
            }
            Self::Signature(input) | Self::Decode(input) => &input.artifact_id,
            Self::Extract(input) => {
                entry(&input.entry)?;
                &input.artifact_id
            }
            Self::Build(input) => &input.artifact_id,
            Self::Scan(input) => {
                rules(&input.rules)?;
                &input.artifact_id
            }
            Self::Splits(input) => {
                spec(&input.device_spec)?;
                deviceforge_android_package_core::apks::Selection {
                    modules: input.modules.clone(),
                    instant: input.instant,
                }
                .validate(&deviceforge_android_package_core::Control::new(
                    None,
                    &|| false,
                ))
                .map_err(|_| "APKS模块选择无效")?;
                &input.artifact_id
            }
        };
        artifact_id(id)
    }
}

fn artifact_id(id: &str) -> Result<(), &'static str> {
    if id.len() != 36 || uuid::Uuid::parse_str(id).is_err() {
        return Err("产物 ID 必须为规范 UUID");
    }
    Ok(())
}

#[cfg(test)]
mod tests;

fn entry(value: &str) -> Result<(), &'static str> {
    if value.len() < 5
        || value.len() > 500
        || !value.to_ascii_lowercase().ends_with(".apk")
        || value.contains(['\\', ':'])
        || value.chars().any(char::is_control)
        || value
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err("APK 条目名称必须为安全的精确相对路径");
    }
    Ok(())
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && (value.as_bytes()[0].is_ascii_alphabetic() || b"_$".contains(&value.as_bytes()[0]))
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_$".contains(&byte))
}

fn rules(values: &[SdkRule]) -> Result<(), &'static str> {
    let mut names = BTreeSet::new();
    if values.is_empty()
        || values.len() > 100
        || values.iter().any(|rule| {
            rule.name.trim().is_empty()
                || rule.name.len() > 100
                || rule.name.chars().any(char::is_control)
                || !names.insert(rule.name.as_str())
                || rule.package_path.len() > 200
                || !rule.package_path.split('.').all(identifier)
                || rule
                    .class_name
                    .as_ref()
                    .is_some_and(|value| value.len() > 100 || !identifier(value))
        })
    {
        return Err("SDK 规则名称、包路径或类名无效");
    }
    Ok(())
}

fn spec(value: &DeviceSpec) -> Result<(), &'static str> {
    value
        .validate(&deviceforge_android_package_core::Control::new(
            None,
            &|| false,
        ))
        .map_err(|_| "设备规格列表或数值无效")
}
