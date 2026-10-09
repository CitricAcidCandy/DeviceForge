use apk_domain::{
    Error, Executor, Operation, Result,
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
        if operation != "android.package.build_apks" {
            return Err(Error::NotFound(operation.into()));
        }
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let request: BuildApksRequest =
            serde_json::from_value(input).map_err(|e| Error::Invalid(e.to_string()))?;
        request.validate()?;
        serde_json::to_value(self.0.build(request, cancel).await?)
            .map_err(|e| Error::Dependency(e.to_string()))
    }
}
