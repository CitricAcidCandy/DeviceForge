use super::*;
use apk_domain::{ExecutionContext, Executor, Operation};
use async_trait::async_trait;
use serde_json::{Value, json};
fn schema<T: schemars::JsonSchema>() -> Value {
    let mut settings = schemars::generate::SchemaSettings::draft2020_12();
    settings.inline_subschemas = true;
    serde_json::to_value(settings.into_generator().into_root_schema_for::<T>())
        .expect("性能模式必须可序列化")
}
fn input<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|error| Error::Invalid(error.to_string()))
}
#[async_trait]
impl Executor for PerformanceService {
    fn operations(&self) -> Vec<Operation> {
        let mut operations: Vec<_> = [
            ("start", "开始性能采样", schema::<PerformanceStart>()),
            ("inspect", "查看性能会话", schema::<PerformanceId>()),
            ("pause", "暂停性能采样", schema::<PerformanceId>()),
            ("resume", "继续性能采样", schema::<PerformanceId>()),
            ("stop", "结束性能采样", schema::<PerformanceId>()),
            (
                "samples",
                "分页读取性能样本",
                schema::<PerformanceSamples>(),
            ),
            ("list", "分页读取性能会话", schema::<PerformanceList>()),
        ]
        .into_iter()
        .map(|(name, title, input_schema)| Operation {
            execution: None,
            id: format!("android.performance.{name}"),
            title: title.into(),
            input_schema,
        })
        .collect();
        operations.push(Operation {
            execution: None,
            id: "android.performance.capabilities".into(),
            title: "查看性能采样能力".into(),
            input_schema: json!({"type":"object","additionalProperties":false}),
        });
        operations
    }
    async fn execute(
        &self,
        operation: &str,
        value: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.execute_with_context(operation, value, cancel, ExecutionContext::default())
            .await
    }
    async fn execute_with_context(
        &self,
        operation: &str,
        value: Value,
        cancel: CancellationToken,
        execution: ExecutionContext,
    ) -> Result<Value> {
        let context = CallContext::new(cancel.clone(), execution.deadline.map(Instant::from_std));
        context.check()?;
        let result = match operation {
            "android.performance.start" => serde_json::to_value(
                self.start_with_context(input(value)?, cancel, context.deadline)
                    .await?,
            ),
            "android.performance.inspect" => serde_json::to_value(
                self.get_with_context(input::<PerformanceId>(value)?.session_id, &context)
                    .await?,
            ),
            "android.performance.pause"
            | "android.performance.resume"
            | "android.performance.stop" => {
                let state = match operation {
                    "android.performance.pause" => PerformanceState::Paused,
                    "android.performance.resume" => PerformanceState::Running,
                    _ => PerformanceState::Stopped,
                };
                serde_json::to_value(
                    self.change_with_context(
                        input::<PerformanceId>(value)?.session_id,
                        state,
                        context.cancel.clone(),
                        context.deadline,
                    )
                    .await?,
                )
            }
            "android.performance.samples" => {
                serde_json::to_value(self.samples_with_context(input(value)?, &context).await?)
            }
            "android.performance.list" => {
                serde_json::to_value(self.list_with_context(input(value)?, &context).await?)
            }
            "android.performance.capabilities" => {
                if !value.is_object() || !value.as_object().is_some_and(|object| object.is_empty())
                {
                    return Err(Error::Invalid("性能能力查询不接受参数".into()));
                }
                let capability = self.capabilities()?;
                let mut metrics = vec![
                    "cpu_share_percent",
                    "cpu_core_percent",
                    "pss_kib",
                    "rss_kib",
                ];
                if capability.fps {
                    metrics.push("fps");
                }
                if capability.device_observation {
                    metrics.extend(["device_observation", "battery_net_power_mw"]);
                }
                let mut result = json!({"metrics":metrics,"fps":capability.fps,"source":capability.source,"scope":"main_process","max_samples":3600,"sample_timeout_ms":10000});
                if capability.device_observation {
                    result["device_observation"] = json!(true);
                }
                return Ok(result);
            }
            _ => return Err(Error::NotFound(operation.into())),
        };
        result.map_err(|error| Error::Dependency(error.to_string()))
    }
}
