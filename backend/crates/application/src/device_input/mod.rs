use apk_domain::{
    Error, Executor, Operation, Result,
    device_input::{DeviceInput, InputRequest},
};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct InputOperations(pub Arc<dyn DeviceInput>);
#[async_trait]
impl Executor for InputOperations {
    fn operations(&self) -> Vec<Operation> {
        let mut settings = schemars::generate::SchemaSettings::draft2020_12();
        settings.inline_subschemas = true;
        let schema = settings
            .into_generator()
            .into_root_schema_for::<InputRequest>();
        vec![Operation {
            id: "android.input".into(),
            title: "Android 点击、滑动、按键和文本输入".into(),
            input_schema: serde_json::to_value(schema).expect("设备输入模式必须可序列化"),
        }]
    }
    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        if operation != "android.input" {
            return Err(Error::NotFound(operation.into()));
        }
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let request: InputRequest =
            serde_json::from_value(input).map_err(|e| Error::Invalid(e.to_string()))?;
        request.validate()?;
        serde_json::to_value(self.0.dispatch(request, cancel).await?)
            .map_err(|e| Error::Dependency(e.to_string()))
    }
}
