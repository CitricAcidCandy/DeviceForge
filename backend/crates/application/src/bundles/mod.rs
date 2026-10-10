use apk_domain::{
    Error, ExecutionContext, Executor, Operation, Result,
    bundles::{BuildApksRequest, BundleBuilder},
};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct BundleOperations(pub Arc<dyn BundleBuilder>);
#[async_trait]
impl Executor for BundleOperations {
    fn operations(&self) -> Vec<Operation> {
        let mut settings = schemars::generate::SchemaSettings::draft2020_12();
        settings.inline_subschemas = true;
        let schema = settings
            .into_generator()
            .into_root_schema_for::<BuildApksRequest>();
        vec![Operation {
            execution: None,
            id: "android.package.build_apks".into(),
            title: "将 AAB 构建为签名 APKS 产物".into(),
            input_schema: serde_json::to_value(schema).expect("构建模式可序列化"),
        }]
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
        if operation != "android.package.build_apks" {
            return Err(Error::NotFound(operation.into()));
        }
        crate::operation_budget::check(
            context.deadline.map(tokio::time::Instant::from_std),
            Some(&cancel),
        )?;
        let request: BuildApksRequest =
            serde_json::from_value(input).map_err(|e| Error::Invalid(e.to_string()))?;
        request.validate()?;
        serde_json::to_value(self.0.build_with_context(request, cancel, context).await?)
            .map_err(|e| Error::Dependency(e.to_string()))
    }
}

#[cfg(test)]
mod context_tests;
