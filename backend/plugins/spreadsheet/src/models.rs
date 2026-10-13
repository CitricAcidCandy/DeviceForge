use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Format { Xlsx, Xls, Csv }
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum Sheet { Name(String), Index(usize) }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Inspect { pub artifact_id: String }
fn default_limit() -> usize { 100 }
fn present_sheet<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<Sheet>, D::Error> {
    Sheet::deserialize(d).map(Some)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Read {
    pub artifact_id: String,
    #[serde(default, deserialize_with = "present_sheet")]
    pub sheet: Option<Sheet>,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_limit")]
    pub limit: usize,
}
pub(crate) enum Operation { Inspect, Read(Read) }
pub(crate) struct Input {
    pub artifact: apk_plugin_sdk::ArtifactInput,
    pub format: Format,
    pub operation: Operation,
}
#[derive(Debug, Serialize)]
pub(crate) struct SheetInfo { pub name: String, pub index: usize }
#[derive(Serialize)]
pub(crate) struct Metadata {
    pub format_version: u32,
    pub artifact_id: String,
    pub source_filename: String,
    pub format: Format,
    pub sheets: Vec<SheetInfo>,
}
#[derive(Serialize)]
pub(crate) struct Page {
    #[serde(flatten)]
    pub metadata: Metadata,
    pub sheet_name: String,
    pub headers: Vec<String>,
    pub rows: Vec<Map<String, Value>>,
    pub total_rows: usize,
    pub offset: usize,
    pub limit: usize,
}
