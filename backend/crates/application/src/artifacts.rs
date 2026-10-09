use apk_domain::{Error, Executor, Operation, Result, artifacts::ArtifactStore};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct ArtifactOperations(pub Arc<dyn ArtifactStore>);
#[async_trait]
impl Executor for ArtifactOperations {
    fn operations(&self) -> Vec<Operation> {
        let input = json!({"type":"object","properties":{"artifact_id":{"type":"string","format":"uuid"}},"required":["artifact_id"],"additionalProperties":false});
        let mut entries = input.clone();
        entries["properties"]["offset"] = json!({"type":"integer","minimum":0});
        entries["properties"]["limit"] = json!({"type":"integer","minimum":1,"maximum":200});
        vec![
            Operation {
                id: "artifact.inspect".into(),
                title: "读取产物元数据".into(),
                input_schema: input,
            },
            Operation {
                id: "artifact.archive.entries".into(),
                title: "分页预览压缩包条目".into(),
                input_schema: entries,
            },
        ]
    }
    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let id = input["artifact_id"]
            .as_str()
            .ok_or_else(|| Error::Invalid("缺少产物 ID".into()))?;
        let value = match operation {
            "artifact.inspect" => serde_json::to_value(self.0.get(id).await?),
            "artifact.archive.entries" => {
                let number = |key: &str, default: usize| -> Result<usize> {
                    match input.get(key) {
                        None => Ok(default),
                        Some(value) => value
                            .as_u64()
                            .and_then(|v| usize::try_from(v).ok())
                            .ok_or_else(|| Error::Invalid(format!("{key} 参数无效"))),
                    }
                };
                serde_json::to_value(
                    self.0
                        .archive_entries(id, number("offset", 0)?, number("limit", 50)?)
                        .await?,
                )
            }
            _ => return Err(Error::NotFound(operation.into())),
        };
        value.map_err(|e| Error::Dependency(e.to_string()))
    }
}
