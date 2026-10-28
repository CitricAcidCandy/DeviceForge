//! HTTP、MCP 与 CLI 共用的安装任务；安装状态查询仍使用只读用例。
use crate::plugin_installations::InstallationService;
use apk_domain::{
    Error, Executor, Operation, OperationExecution, OperationExecutionSource, Result,
    plugin_installations::*,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, OnceLock};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallationRequest {
    pub source: InstallSource,
    #[serde(default)]
    pub expected_revision: Option<String>,
}
#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallationUpdate {
    pub id: String,
    pub source: InstallSource,
    pub expected_revision: String,
}
#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallationChange {
    pub id: String,
    pub expected_revision: String,
    pub enabled: bool,
}
#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallationDelete {
    pub id: String,
    pub expected_revision: String,
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct InstallationCleanup {
    #[serde(default = "default_dry_run")]
    pub dry_run: bool,
}
fn default_dry_run() -> bool {
    true
}

#[derive(Default)]
pub struct InstallationOperations(OnceLock<Arc<InstallationService>>);
impl InstallationOperations {
    pub fn bind(&self, service: Arc<InstallationService>) -> Result<()> {
        self.0
            .set(service)
            .map_err(|_| Error::Conflict("安装服务已绑定".into()))
    }
}
fn schema<T: schemars::JsonSchema>() -> Value {
    serde_json::to_value(schemars::SchemaGenerator::default().into_root_schema_for::<T>())
        .expect("公开安装请求模式有效")
}
#[async_trait]
impl Executor for InstallationOperations {
    fn operations(&self) -> Vec<Operation> {
        [
            (
                "installation.install",
                "安装完整功能插件",
                schema::<InstallationRequest>(),
            ),
            (
                "installation.update",
                "更新完整功能插件",
                schema::<InstallationUpdate>(),
            ),
            (
                "installation.enabled",
                "更改完整功能插件启停",
                schema::<InstallationChange>(),
            ),
            (
                "installation.uninstall",
                "卸载完整功能插件并保留配置",
                schema::<InstallationDelete>(),
            ),
            (
                "installation.cleanup",
                "检查或清理没有引用的托管资源",
                schema::<InstallationCleanup>(),
            ),
            (
                "installation.reload",
                "按当前修订重载完整发布；浏览器运行仍须原共同加载层确认",
                schema::<InstallationActionRequest>(),
            ),
            (
                "installation.restore_successful",
                "恢复上一份宿主激活成功代码包；保留启停意图，不回滚业务数据",
                schema::<InstallationActionRequest>(),
            ),
        ]
        .into_iter()
        .map(|(id, title, input_schema)| Operation {
            id: id.into(),
            title: title.into(),
            input_schema,
            execution: Some(OperationExecution {
                api_version: 1,
                total_timeout_ms: if matches!(
                    id,
                    "installation.reload" | "installation.restore_successful"
                ) {
                    30_000
                } else {
                    3_600_000
                },
                source: OperationExecutionSource::Declared,
            }),
        })
        .collect()
    }
    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.execute_with_context(operation, input, cancel, Default::default())
            .await
    }
    async fn execute_with_context(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        context: apk_domain::ExecutionContext,
    ) -> Result<Value> {
        self.execute_with_progress(
            operation,
            input,
            cancel,
            context,
            Arc::new(apk_domain::NoProgress),
        )
        .await
    }
    async fn execute_with_progress(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        context: apk_domain::ExecutionContext,
        progress: Arc<dyn apk_domain::ProgressReporter>,
    ) -> Result<Value> {
        if context
            .deadline
            .is_some_and(|deadline| std::time::Instant::now() >= deadline)
        {
            return Err(Error::Timeout);
        }
        let execution = self.run(operation, input, cancel.clone(), progress, context);
        tokio::pin!(execution);
        if let Some(deadline) = context.deadline {
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(deadline.into()) => {
                    cancel.cancel();
                    // 提交阶段由独立生命周期任务持有门禁，必须等其恢复稳定。
                    let _ = execution.await;
                    Err(Error::Timeout)
                },
                result = &mut execution => result,
            }
        } else {
            execution.await
        }
    }
}

impl InstallationOperations {
    async fn run(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        progress: Arc<dyn apk_domain::ProgressReporter>,
        context: apk_domain::ExecutionContext,
    ) -> Result<Value> {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let service = self
            .0
            .get()
            .ok_or_else(|| Error::Dependency("安装服务未绑定".into()))?;
        let decode = |error: serde_json::Error| Error::Invalid(error.to_string());
        let record = match operation {
            "installation.reload" | "installation.restore_successful" => {
                let input: InstallationActionRequest =
                    serde_json::from_value(input).map_err(decode)?;
                if !input.confirmed {
                    return Err(Error::Conflict("整套重载或代码恢复需要本次显式确认".into()));
                }
                service
                    .release_action(
                        input.id,
                        input.expected_revision,
                        operation == "installation.restore_successful",
                        cancel,
                        context,
                        progress,
                    )
                    .await?
            }
            "installation.install" => {
                let input: InstallationRequest = serde_json::from_value(input).map_err(decode)?;
                service
                    .install_with_execution(
                        input.source,
                        input.expected_revision,
                        cancel,
                        progress,
                        context,
                    )
                    .await?
            }
            "installation.update" => {
                let input: InstallationUpdate = serde_json::from_value(input).map_err(decode)?;
                let old = service.get(&input.id).await?;
                if old.revision != input.expected_revision {
                    return Err(Error::Conflict("安装修订已变化".into()));
                }
                service
                    .install_with_execution(
                        input.source,
                        Some(input.expected_revision),
                        cancel,
                        progress,
                        context,
                    )
                    .await?
            }
            "installation.enabled" => {
                let input: InstallationChange = serde_json::from_value(input).map_err(decode)?;
                service
                    .set_enabled_cancelled(input.id, input.expected_revision, input.enabled, cancel)
                    .await?
            }
            "installation.uninstall" => {
                let input: InstallationDelete = serde_json::from_value(input).map_err(decode)?;
                service
                    .delete_cancelled(input.id, input.expected_revision, cancel)
                    .await?
            }
            "installation.cleanup" => {
                let input: InstallationCleanup = serde_json::from_value(input).map_err(decode)?;
                let report = service
                    .cleanup_resources_cancelled(input.dry_run, cancel)
                    .await?;
                return serde_json::to_value(report)
                    .map_err(|_| Error::Dependency("资源清理结果编码失败".into()));
            }
            _ => return Err(Error::NotFound(operation.into())),
        };
        serde_json::to_value(record).map_err(|_| Error::Dependency("安装结果编码失败".into()))
    }
}
