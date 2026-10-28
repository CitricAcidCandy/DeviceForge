//! 服务器试调用保留原服务准入、精确提供者代际与 Job，不引入调试执行器。
use crate::ApiError;
use apk_application::{Application, debugger::DebugTarget};
use apk_domain::services::ServiceCallRequest;
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct InvokeInput {
    kind: InvokeKind,
    id: String,
    #[serde(default)]
    version: Option<String>,
    input: Value,
    confirmed: bool,
    allow_unknown_side_effects: bool,
}

#[derive(PartialEq, Eq, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
enum InvokeKind {
    Service,
    Operation,
}

pub(super) async fn invoke(
    app: &Arc<Application>,
    target: &DebugTarget,
    input: Value,
) -> Result<Value, ApiError> {
    let input: InvokeInput = serde_json::from_value(input).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "debugger_invalid_input",
            "服务器试调用需要入口种类、标识、JSON 输入和两项显式副作用确认；服务另需精确版本",
        )
    })?;
    if !input.confirmed || !input.allow_unknown_side_effects {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "debugger_confirmation_required",
            "试调用可能影响设备或外部资源，请显式确认本次调用及未知副作用；不会自动调用或重试",
        ));
    }
    if input.kind == InvokeKind::Operation {
        if input.version.is_some() {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "debugger_invalid_input",
                "普通操作按所选插件代次调用，不接受服务版本字段",
            ));
        }
        let job = app
            .debug_submit_operation(target, input.id, input.input)
            .await?;
        return Ok(
            json!({"job_id":job.id,"operation":job.operation,"status":job.status,
            "result_in_original_job":true,"note":"取消调试等待不等于取消已接受任务；请通过原任务入口查询或显式取消"}),
        );
    }
    let version = input.version.ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "debugger_invalid_input",
            "服务试调用必须指定精确版本",
        )
    })?;
    let owned = app.services()?.into_iter().any(|service| {
        service.service.id == input.id
            && service.service.version == version
            && service.provider.id == target.plugin_id
            && Some(service.provider.generation.as_str()) == target.generation.as_deref()
    });
    if !owned {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "debugger_target_changed",
            "当前服务不属于所选插件、代次或精确版本，请重新查询目标与服务目录",
        ));
    }
    let job = app
        .call_service(
            input.id,
            ServiceCallRequest {
                version,
                input: input.input,
                generation: target.generation.clone(),
            },
        )
        .await?;
    // 不复制任务输入和任意插件输出；调用方沿原 Job 查询实际执行结果。
    Ok(
        json!({"job_id":job.id,"operation":job.operation,"status":job.status,
        "result_in_original_job":true,"note":"取消调试等待不等于取消已接受任务；请通过原任务入口查询或显式取消"}),
    )
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use apk_application::plugin_lifecycle::PluginService;
    use apk_domain::{
        Executor, Operation,
        plugins::{PluginCatalog, PluginContribution},
        services::*,
    };
    use apk_infrastructure::store::SqliteStore;
    use async_trait::async_trait;
    use tokio_util::sync::CancellationToken;

    struct Echo;
    #[async_trait]
    impl Executor for Echo {
        fn operations(&self) -> Vec<Operation> {
            vec![Operation {
                id: "plugin.example.echo".into(),
                title: "回显".into(),
                input_schema: json!({"type":"object"}),
                execution: None,
            }]
        }
        fn services(&self) -> ServiceAccess {
            ServiceAccess {
                provided: vec![ProvidedService {
                    service: ServiceRef {
                        id: "plugin.example.echo".into(),
                        version: "1".into(),
                    },
                    operation: "plugin.example.echo".into(),
                    contract: ServiceContract {
                        input_schema: json!({"type":"object"}),
                        output_schema: json!({"type":"object"}),
                    },
                }],
                required: vec![],
            }
        }
        async fn execute(
            &self,
            _: &str,
            input: Value,
            _: CancellationToken,
        ) -> apk_domain::Result<Value> {
            Ok(input)
        }
    }
    struct Catalog;
    fn contribution() -> PluginContribution {
        PluginContribution {
            id: "example".into(),
            version: "0.1".into(),
            executor: Arc::new(Echo),
        }
    }
    #[async_trait]
    impl PluginCatalog for Catalog {
        async fn load(&self, _: &str) -> apk_domain::Result<PluginContribution> {
            Ok(contribution())
        }
    }
    pub(in crate::debugger) async fn fixture() -> (Arc<Application>, Arc<PluginService>, DebugTarget)
    {
        let app = Application::new(
            Arc::new(SqliteStore::open(":memory:").unwrap()),
            vec![],
            1,
            4,
        )
        .unwrap();
        let plugins = PluginService::new(app.clone(), Arc::new(Catalog), Default::default());
        let plugin = plugins.seed(contribution()).await.unwrap();
        let target = DebugTarget {
            target_kind: apk_application::debugger::TargetKind::Server,
            instance_id: None,
            plugin_id: plugin.id,
            generation: Some(plugin.generation),
            version: Some(plugin.version),
        };
        (app, plugins, target)
    }
    fn input() -> Value {
        json!({"kind":"service","id":"plugin.example.echo","version":"1","input":{"sample":"sentinel"},"confirmed":true,"allow_unknown_side_effects":true})
    }

    #[tokio::test]
    async fn debugger_server_service_returns_existing_job_without_copying_payload() {
        let (app, _, target) = fixture().await;
        let result = invoke(&app, &target, input())
            .await
            .unwrap_or_else(|error| panic!("{}: {}", error.1.code, error.1.message));
        assert!(result["job_id"].is_string());
        assert!(result.get("input").is_none());
        assert!(!result.to_string().contains("sentinel"));
        let job = app
            .get_async(result["job_id"].as_str().unwrap().into())
            .await
            .unwrap();
        assert_eq!(job.operation, "plugin.example.echo");
        app.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn debugger_server_service_requires_confirmation_exact_version_and_current_generation() {
        let (app, plugins, target) = fixture().await;
        let mut request = input();
        request["confirmed"] = json!(false);
        assert_eq!(
            invoke(&app, &target, request).await.err().unwrap().1.code,
            "debugger_confirmation_required"
        );
        let mut request = input();
        request["version"] = json!("latest");
        assert_eq!(
            invoke(&app, &target, request).await.err().unwrap().1.code,
            "debugger_target_changed"
        );
        plugins.unload("example".into()).await.unwrap();
        plugins.load("example".into()).await.unwrap();
        assert_eq!(
            invoke(&app, &target, input()).await.err().unwrap().1.code,
            "debugger_target_changed"
        );
        app.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn debugger_server_operation_uses_original_job_and_rejects_wrong_generation() {
        let (app, plugins, target) = fixture().await;
        let request = json!({"kind":"operation","id":"plugin.example.echo","input":{},
            "confirmed":true,"allow_unknown_side_effects":true});
        let result = invoke(&app, &target, request.clone())
            .await
            .unwrap_or_else(|error| panic!("{}", error.1.code));
        assert!(result["job_id"].is_string());
        assert_eq!(
            app.get_async(result["job_id"].as_str().unwrap().into())
                .await
                .unwrap()
                .operation,
            "plugin.example.echo"
        );
        let mut wrong = request.clone();
        wrong["id"] = json!("artifact.inspect");
        assert!(invoke(&app, &target, wrong).await.is_err());
        plugins.unload("example".into()).await.unwrap();
        plugins.load("example".into()).await.unwrap();
        assert!(invoke(&app, &target, request).await.is_err());
        app.shutdown().await.unwrap();
    }
}
