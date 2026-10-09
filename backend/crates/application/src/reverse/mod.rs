use apk_domain::{Error, Executor, Operation, Result, reverse::PackageReverse};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct ReverseOperations(pub Arc<dyn PackageReverse>);
#[async_trait]
impl Executor for ReverseOperations {
    fn operations(&self) -> Vec<Operation> {
        let input = json!({"type":"object","properties":{"artifact_id":{"type":"string","format":"uuid"}},"required":["artifact_id"],"additionalProperties":false});
        let mut scan = input.clone();
        scan["properties"]["rules"] = json!({"type":"array","minItems":1,"maxItems":100,"items":{"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":100},"package_path":{"type":"string","minLength":1,"maxLength":200},"class_name":{"type":["string","null"],"minLength":1,"maxLength":100}},"required":["name","package_path"],"additionalProperties":false}});
        scan["required"] = json!(["artifact_id", "rules"]);
        vec![
            Operation {
                id: "android.package.decode".into(),
                title: "反编译 APK 为 ZIP 产物".into(),
                input_schema: input,
            },
            Operation {
                id: "android.package.scan_sdks".into(),
                title: "检测反编译产物中的 SDK 路径".into(),
                input_schema: scan,
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
        let id = input
            .get("artifact_id")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Invalid("缺少产物 ID".into()))?;
        let result = match operation {
            "android.package.decode" => serde_json::to_value(self.0.decode(id, cancel).await?),
            "android.package.scan_sdks" => {
                let rules = serde_json::from_value(
                    input
                        .get("rules")
                        .cloned()
                        .ok_or_else(|| Error::Invalid("缺少 SDK 规则".into()))?,
                )
                .map_err(|e| Error::Invalid(e.to_string()))?;
                serde_json::to_value(self.0.scan_sdks(id, rules, cancel).await?)
            }
            _ => return Err(Error::NotFound(operation.into())),
        };
        result.map_err(|e| Error::Dependency(e.to_string()))
    }
}
