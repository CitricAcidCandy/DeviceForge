use apk_domain::{Error, ExecutionContext, Executor, Operation, Result, packages::PackageAnalyzer};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct PackageOperations(pub Arc<dyn PackageAnalyzer>);
#[async_trait]
impl Executor for PackageOperations {
    fn operations(&self) -> Vec<Operation> {
        [("android.package.manifest", "分析 APK / AAB 清单", Some("module")),
         ("android.package.signature", "验证 APK 签名", None),
         ("android.package.extract_apk", "提取 APKS 内的 APK", Some("entry"))]
            .into_iter().map(|(id, title, extra)| {
                let mut schema = json!({"type":"object","properties":{"artifact_id":{"type":"string","format":"uuid"}},"required":["artifact_id"],"additionalProperties":false});
                if extra == Some("module") {
                    schema["properties"]["module"] = json!({"type":"string","pattern":"^[A-Za-z][A-Za-z0-9_]{0,79}$","description":"AAB 模块名，默认 base；APK 不接受此参数"});
                } else if extra == Some("entry") {
                    schema["properties"]["entry"] = json!({"type":"string","minLength":5,"maxLength":500,"description":"APKS 中 APK 条目的精确名称"});
                    schema["required"].as_array_mut().expect("必填数组").push(json!("entry"));
                }
                Operation { execution: None, id:id.into(), title:title.into(), input_schema:schema }
            }).collect()
    }
    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.execute_with_context(operation, input, cancel, ExecutionContext::default())
            .await
    }

    fn has_unresolved_resources(&self) -> bool {
        self.0.has_unresolved_resources()
    }

    async fn execute_with_context(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<Value> {
        crate::operation_budget::check(
            context.deadline.map(tokio::time::Instant::from_std),
            Some(&cancel),
        )?;
        let id = input
            .get("artifact_id")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Invalid("缺少产物 ID".into()))?;
        let result = match operation {
            "android.package.manifest" => {
                let module = match input.get("module") {
                    None => None,
                    Some(value) => Some(
                        value
                            .as_str()
                            .ok_or_else(|| Error::Invalid("module 必须为字符串".into()))?,
                    ),
                };
                serde_json::to_value(
                    self.0
                        .manifest_with_context(id, module, cancel, context)
                        .await?,
                )
            }
            "android.package.signature" => {
                serde_json::to_value(self.0.signature_with_context(id, cancel, context).await?)
            }
            "android.package.extract_apk" => {
                let entry = input
                    .get("entry")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::Invalid("缺少 APK 条目名称".into()))?;
                serde_json::to_value(
                    self.0
                        .extract_apk_with_context(id, entry, cancel, context)
                        .await?,
                )
            }
            _ => return Err(Error::NotFound(operation.into())),
        };
        result.map_err(|e| Error::Dependency(e.to_string()))
    }
}

#[cfg(test)]
mod context_tests;
