use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Rule {
    pub name: String,
    pub package_path: String,
    #[serde(default)]
    pub class_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct Finding {
    pub rule: Rule,
    pub package_found: bool,
    pub class_found: Option<bool>,
    pub evidence: Vec<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct Counts {
    pub strings: u32,
    pub types: u32,
    pub prototypes: u32,
    pub fields: u32,
    pub methods: u32,
    pub defined_classes: u32,
}

pub(crate) struct Analysis {
    pub version: String,
    pub file_size: usize,
    pub counts: Counts,
    pub classes: Vec<String>,
}
