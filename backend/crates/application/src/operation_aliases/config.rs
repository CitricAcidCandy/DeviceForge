//! 部署绑定配置；嵌套声明拒绝未知字段，公开操作沿用领域类型。
use apk_domain::{Operation, Result};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub format_version: u32,
    pub bindings: Vec<Binding>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            format_version: 1,
            bindings: Vec::new(),
        }
    }
}

impl Config {
    pub fn validate(&self) -> Result<()> {
        super::rules::validate(self)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    #[serde(deserialize_with = "operation")]
    pub operation: Operation,
    pub target: Target,
    pub input: InputMapping,
    pub result: ResultMapping,
}

impl Binding {
    pub fn plugin_id(&self) -> &str {
        match &self.target {
            Target::DeviceCapability { plugin_id, .. }
            | Target::Operation { plugin_id, .. }
            | Target::DeviceDiscovery { plugin_id } => plugin_id,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    DeviceDiscovery {
        plugin_id: String,
    },
    DeviceCapability {
        plugin_id: String,
        capability: String,
        version: u32,
    },
    Operation {
        plugin_id: String,
        operation: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputMapping {
    Identity,
    DeviceEnvelope,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResultMapping {
    DeviceDiscovery {
        platform: String,
    },
    /// 空结构变体让 serde 拒绝多余属性；普通单位变体会忽略属性。
    Identity {},
    Value {
        wrapped: bool,
    },
    Artifact {
        filename: String,
    },
    Object {
        wrapped: bool,
        fields: Vec<ResultField>,
    },
}

impl ResultMapping {
    /// 仅声明投影是否依赖宿主结果；发布来源仍由执行器端口和注册准入证明。
    pub fn requires_host_result(&self) -> bool {
        match self {
            Self::Identity {} | Self::DeviceDiscovery { .. } => false,
            Self::Value { wrapped } => *wrapped,
            Self::Artifact { .. } => true,
            Self::Object { wrapped, fields } => {
                *wrapped
                    || fields
                        .iter()
                        .any(|field| matches!(field.source, FieldSource::Artifact { .. }))
            }
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResultField {
    pub name: String,
    pub source: FieldSource,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FieldSource {
    Input { pointer: String },
    Value { pointer: String },
    Artifact { filename: String },
}

fn operation<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Operation, D::Error> {
    // 领域 Operation 兼容既有调用；只有部署配置边界额外拒绝未知属性。
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Declaration {
        id: String,
        title: String,
        input_schema: Value,
    }
    let declaration = Declaration::deserialize(deserializer)?;
    Ok(Operation {
        execution: None,
        id: declaration.id,
        title: declaration.title,
        input_schema: declaration.input_schema,
    })
}
