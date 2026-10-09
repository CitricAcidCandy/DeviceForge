use super::*;
use apk_domain::{Executor, Operation};
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
            id: format!("android.performance.{name}"),
            title: title.into(),
            input_schema,
        })
        .collect();
        operations.push(Operation {
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
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let result = match operation {
            "android.performance.start" => {
                serde_json::to_value(self.start(input(value)?, cancel).await?)
            }
            "android.performance.inspect" => {
                serde_json::to_value(self.get(input::<PerformanceId>(value)?.session_id).await?)
            }
            "android.performance.pause"
            | "android.performance.resume"
            | "android.performance.stop" => {
                let state = match operation {
                    "android.performance.pause" => PerformanceState::Paused,
                    "android.performance.resume" => PerformanceState::Running,
                    _ => PerformanceState::Stopped,
                };
                serde_json::to_value(
                    self.change(input::<PerformanceId>(value)?.session_id, state)
                        .await?,
                )
            }
            "android.performance.samples" => {
                serde_json::to_value(self.samples(input(value)?).await?)
            }
            "android.performance.list" => serde_json::to_value(self.list(input(value)?).await?),
            "android.performance.capabilities" => {
                if !value.is_object() || !value.as_object().is_some_and(|object| object.is_empty())
                {
                    return Err(Error::Invalid("性能能力查询不接受参数".into()));
                }
                let capability = self.0.probe.capabilities();
                let mut metrics = vec![
                    "cpu_share_percent",
                    "cpu_core_percent",
                    "pss_kib",
                    "rss_kib",
                ];
                if capability.fps {
                    metrics.push("fps");
                }
                return Ok(
                    json!({"metrics":metrics,"fps":capability.fps,"source":capability.source,"scope":"main_process","max_samples":3600,"sample_timeout_ms":10000}),
                );
            }
            _ => return Err(Error::NotFound(operation.into())),
        };
        result.map_err(|error| Error::Dependency(error.to_string()))
    }
}
