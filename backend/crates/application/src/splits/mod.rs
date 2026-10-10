use apk_domain::{
    Error, ExecutionContext, Executor, Operation, Result,
    splits::{ExtractSplitsRequest, InstallApksRequest, SplitPackages},
};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
mod install;
pub use install::InstallApksOperations;

pub struct SplitOperations(pub Arc<dyn SplitPackages>);
pub(super) fn operation<T: schemars::JsonSchema>(id: &str, title: &str) -> Operation {
    let mut settings = schemars::generate::SchemaSettings::draft2020_12();
    settings.inline_subschemas = true;
    Operation {
        execution: None,
        id: id.into(),
        title: title.into(),
        input_schema: serde_json::to_value(settings.into_generator().into_root_schema_for::<T>())
            .expect("分包请求模式可序列化"),
    }
}
#[async_trait]
impl Executor for SplitOperations {
    fn operations(&self) -> Vec<Operation> {
        let mut extract = operation::<ExtractSplitsRequest>(
            "android.package.extract_splits",
            "按设备规格提取 APKS 分包",
        );
        for key in ["supported_abis", "supported_locales"] {
            extract.input_schema["properties"]["device_spec"]["properties"][key]["uniqueItems"] =
                Value::Bool(true);
        }
        vec![
            extract,
            operation::<InstallApksRequest>("android.app.install_apks", "匹配指定设备并安装 APKS"),
        ]
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
        let result = match operation {
            "android.package.extract_splits" => {
                let request: ExtractSplitsRequest =
                    serde_json::from_value(input).map_err(|e| Error::Invalid(e.to_string()))?;
                request.validate()?;
                serde_json::to_value(
                    self.0
                        .extract_with_context(request, cancel, context)
                        .await?,
                )
            }
            "android.app.install_apks" => {
                let request: InstallApksRequest =
                    serde_json::from_value(input).map_err(|e| Error::Invalid(e.to_string()))?;
                request.validate()?;
                serde_json::to_value(self.0.install(request, cancel).await?)
            }
            _ => return Err(Error::NotFound(operation.into())),
        };
        result.map_err(|e| Error::Dependency(e.to_string()))
    }
}

#[cfg(test)]
mod context_tests;
#[cfg(test)]
mod install_tests;
