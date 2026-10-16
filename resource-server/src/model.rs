use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    Plugin,
    Tool,
    Config,
    Distribution,
    Resource,
}

impl ResourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plugin => "plugin",
            Self::Tool => "tool",
            Self::Config => "config",
            Self::Distribution => "distribution",
            Self::Resource => "resource",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SupportsMcp {
    None,
    Client,
    Server,
    Both,
}

impl SupportsMcp {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Client => "client",
            Self::Server => "server",
            Self::Both => "both",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RestartPolicy {
    None,
    BrowserRefresh,
    PluginReload,
    ServiceRestart,
    DeviceRestart,
}

impl RestartPolicy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::BrowserRefresh => "browser_refresh",
            Self::PluginReload => "plugin_reload",
            Self::ServiceRestart => "service_restart",
            Self::DeviceRestart => "device_restart",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    Market,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarketEntry {
    pub metadata_version: u32,
    pub id: String,
    pub kind: ResourceKind,
    pub name: String,
    pub version: String,
    pub summary: String,
    pub description: String,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    pub applies_to: Vec<String>,
    pub supports_mcp: SupportsMcp,
    pub supports_agent: bool,
    pub restart_policy: RestartPolicy,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub architectures: Vec<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default = "default_visibility")]
    pub visibility: Visibility,
    #[serde(default)]
    pub resource_id: Option<String>,
    #[serde(default)]
    pub details: Value,
}

fn default_visibility() -> Visibility {
    Visibility::Market
}

#[derive(Debug, Error)]
pub enum MetadataError {
    #[error("市场元数据版本不受支持")]
    Version,
    #[error("市场元数据字段无效：{0}")]
    Field(&'static str),
    #[error("市场元数据分类不适用于该类型")]
    Category,
    #[error("市场元数据专属描述缺失：{0}")]
    Details(&'static str),
}

pub fn validate_market_entry(entry: &MarketEntry) -> Result<(), MetadataError> {
    if entry.metadata_version != 1 {
        return Err(MetadataError::Version);
    }
    if entry.id.is_empty()
        || entry.id.len() > 99
        || !entry.id.as_bytes()[0].is_ascii_alphanumeric()
        || !entry.id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
    {
        return Err(MetadataError::Field("id"));
    }
    if entry.name.trim().is_empty() || entry.name.len() > 160 {
        return Err(MetadataError::Field("name"));
    }
    if entry.version.trim().is_empty() || entry.version.len() > 80 {
        return Err(MetadataError::Field("version"));
    }
    if entry.summary.trim().is_empty() || entry.summary.len() > 400 {
        return Err(MetadataError::Field("summary"));
    }
    if entry.description.len() > 20_000 || entry.applies_to.is_empty() {
        return Err(MetadataError::Field("description/applies_to"));
    }
    if entry.keywords.len() > 64
        || entry.keywords.iter().any(|value| value.trim().is_empty())
        || has_duplicate_values(&entry.keywords)
    {
        return Err(MetadataError::Field("keywords"));
    }
    if entry.categories.len() > 16
        || entry.categories.iter().any(|value| !valid_id(value))
        || has_duplicate_values(&entry.categories)
        || entry
            .categories
            .iter()
            .any(|value| !allowed_category(entry.kind, value))
    {
        return Err(MetadataError::Field("categories"));
    }
    if entry
        .applies_to
        .iter()
        .any(|value| value.trim().is_empty() || value.len() > 100)
    {
        return Err(MetadataError::Field("applies_to"));
    }
    if entry.platforms.iter().any(|value| !valid_id(value))
        || entry.architectures.iter().any(|value| !valid_id(value))
    {
        return Err(MetadataError::Field("platforms/architectures"));
    }
    let details = entry.details.as_object();
    match entry.kind {
        ResourceKind::Tool if details.is_none_or(|details| !details.contains_key("tool_type")) => {
            return Err(MetadataError::Details("tool_type"));
        }
        ResourceKind::Config
            if details.is_none_or(|details| {
                !details.contains_key("config_type") || !details.contains_key("schema_version")
            }) =>
        {
            return Err(MetadataError::Details("config_type/schema_version"));
        }
        ResourceKind::Distribution
            if details.is_none_or(|details| {
                !details.contains_key("package_name") || !details.contains_key("entrypoint")
            }) =>
        {
            return Err(MetadataError::Details("package_name/entrypoint"));
        }
        _ => {}
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
}

fn has_duplicate_values(values: &[String]) -> bool {
    let mut normalized = std::collections::HashSet::new();
    values
        .iter()
        .map(|value| value.trim().to_lowercase())
        .any(|value| !normalized.insert(value))
}

fn allowed_category(kind: ResourceKind, category: &str) -> bool {
    let allowed = match kind {
        ResourceKind::Plugin => ["function", "theme", "ui", "integration"].as_slice(),
        ResourceKind::Tool => ["runtime", "analysis", "device", "build", "utility"].as_slice(),
        ResourceKind::Config => ["preset", "device", "performance", "theme", "workflow"].as_slice(),
        ResourceKind::Distribution | ResourceKind::Resource => &[],
    };
    allowed.is_empty() || allowed.contains(&category)
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CatalogQuery {
    pub kind: Option<String>,
    pub category: Option<String>,
    pub applies_to: Option<String>,
    pub supports_mcp: Option<String>,
    pub supports_agent: Option<bool>,
    pub restart_policy: Option<String>,
    pub platform: Option<String>,
    pub architecture: Option<String>,
    pub q: Option<String>,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

impl CatalogQuery {
    pub fn bounds(&self) -> (usize, usize) {
        (
            self.offset.unwrap_or(0),
            self.limit.unwrap_or(50).clamp(1, 100),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: ResourceKind) -> MarketEntry {
        MarketEntry {
            metadata_version: 1,
            id: "demo".into(),
            kind,
            name: "演示条目".into(),
            version: "1.0.0".into(),
            summary: "演示摘要".into(),
            description: "演示描述".into(),
            keywords: vec!["设备".into()],
            categories: vec![
                match kind {
                    ResourceKind::Tool => "runtime",
                    ResourceKind::Config => "preset",
                    _ => "function",
                }
                .into(),
            ],
            applies_to: vec!["universal".into()],
            supports_mcp: SupportsMcp::Both,
            supports_agent: true,
            restart_policy: RestartPolicy::None,
            platforms: vec!["windows".into()],
            architectures: vec!["x64".into()],
            author: None,
            license: None,
            homepage: None,
            visibility: Visibility::Market,
            resource_id: None,
            details: serde_json::json!({"tool_type":"cli","config_type":"preset","schema_version":1,"package_name":"demo","entrypoint":"deviceforge"}),
        }
    }

    #[test]
    fn validates_type_specific_details() {
        assert!(validate_market_entry(&entry(ResourceKind::Tool)).is_ok());
        let mut plugin = entry(ResourceKind::Plugin);
        plugin.details = Value::Null;
        assert!(validate_market_entry(&plugin).is_ok());
        let mut invalid = entry(ResourceKind::Config);
        invalid.details = serde_json::json!({"config_type":"preset"});
        assert!(matches!(
            validate_market_entry(&invalid),
            Err(MetadataError::Details(_))
        ));
    }

    #[test]
    fn catalog_identity_matches_plugin_identifiers() {
        let mut plugin = entry(ResourceKind::Plugin);
        plugin.id = "demo.plugin-1".into();
        assert!(validate_market_entry(&plugin).is_ok());
        for id in ["../demo", "_demo", "Upper", "demo/plugin"] {
            plugin.id = id.into();
            assert!(validate_market_entry(&plugin).is_err());
        }
    }
}
