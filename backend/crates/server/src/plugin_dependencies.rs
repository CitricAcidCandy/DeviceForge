//! 插件依赖 HTTP 边界；查询共用依赖服务，变更复用公开任务生命周期。
use crate::{ApiError, ApiState};
use apk_application::plugin_dependencies::DependencyService;
use apk_domain::{Error, Job, plugin_dependencies::*};
use axum::{
    Json,
    extract::{
        Path, State,
        rejection::{JsonRejection, PathRejection},
    },
    http::StatusCode,
};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct DependencyQuery {
    pub target: DependencyTarget,
}

fn service(state: &ApiState) -> Result<&Arc<DependencyService>, ApiError> {
    state.dependencies.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_configured",
            "插件依赖服务未配置",
        )
    })
}

fn target(
    path: Result<Path<(DependencyTargetKind, String)>, PathRejection>,
) -> Result<DependencyTarget, ApiError> {
    let Path((kind, id)) = path
        .map_err(|_| Error::Invalid("依赖目标须为 release、server 或 browser 及插件 ID".into()))?;
    apk_domain::plugins::plugin_id(&id)?;
    Ok(DependencyTarget { kind, id })
}

pub(crate) async fn get(
    State(state): State<ApiState>,
    path: Result<Path<(DependencyTargetKind, String)>, PathRejection>,
) -> Result<Json<PluginDependencies>, ApiError> {
    let target = target(path)?;
    Ok(Json(service(&state)?.get(target).await?))
}

async fn change(
    state: ApiState,
    path: Result<Path<(DependencyTargetKind, String)>, PathRejection>,
    input: Result<Json<DependencyChange>, JsonRejection>,
    operation: &str,
) -> Result<(StatusCode, Json<Job>), ApiError> {
    let target = target(path)?;
    let Json(input) = input.map_err(|error| {
        ApiError::new(
            if error.status() == StatusCode::UNPROCESSABLE_ENTITY {
                StatusCode::BAD_REQUEST
            } else {
                error.status()
            },
            "invalid_input",
            "依赖变更须提供 expected_revision 和可选 dependency_ids，且不超过 256 KiB",
        )
    })?;
    service(&state)?;
    let request = DependencyRequest {
        target,
        expected_revision: input.expected_revision,
        dependency_ids: input.dependency_ids,
    };
    let input = serde_json::to_value(request)
        .map_err(|_| Error::Dependency("依赖任务请求编码失败".into()))?;
    let job = state.app.submit_async(operation.into(), input).await?;
    tracing::info!(operation, job_id = %job.id, "插件依赖任务已提交");
    Ok((StatusCode::ACCEPTED, Json(job)))
}

pub(crate) async fn scan(
    State(state): State<ApiState>,
    path: Result<Path<(DependencyTargetKind, String)>, PathRejection>,
    input: Result<Json<DependencyChange>, JsonRejection>,
) -> Result<(StatusCode, Json<Job>), ApiError> {
    change(state, path, input, "dependency.scan").await
}

pub(crate) async fn install(
    State(state): State<ApiState>,
    path: Result<Path<(DependencyTargetKind, String)>, PathRejection>,
    input: Result<Json<DependencyChange>, JsonRejection>,
) -> Result<(StatusCode, Json<Job>), ApiError> {
    change(state, path, input, "dependency.install").await
}

#[cfg(test)]
mod tests {
    use super::*;
    use apk_application::{Application, plugin_dependencies::DependencyOperations};
    use apk_domain::{ExecutionContext, ProgressReporter};
    use apk_infrastructure::store::SqliteStore;
    use async_trait::async_trait;
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::Request,
    };
    use serde_json::{Value, json};
    use std::sync::Mutex;
    use tokio_util::sync::CancellationToken;
    use tower::ServiceExt;

    #[derive(Default)]
    struct Store {
        changes: Mutex<Vec<(String, DependencyRequest)>>,
    }

    fn view(target: DependencyTarget) -> PluginDependencies {
        PluginDependencies {
            target,
            revision: "a".repeat(64),
            dependencies: vec![],
            ready: true,
        }
    }

    #[async_trait]
    impl DependencyStore for Store {
        async fn forget(&self, _: DependencyTarget) -> apk_domain::Result<()> {
            Ok(())
        }

        async fn get(&self, target: DependencyTarget) -> apk_domain::Result<PluginDependencies> {
            if target.id == "missing" {
                return Err(Error::NotFound("依赖目标不存在".into()));
            }
            Ok(view(target))
        }

        async fn scan(
            &self,
            request: DependencyRequest,
            _: CancellationToken,
            _: ExecutionContext,
            _: Arc<dyn ProgressReporter>,
        ) -> apk_domain::Result<PluginDependencies> {
            let result = view(request.target.clone());
            self.changes
                .lock()
                .unwrap()
                .push(("dependency.scan".into(), request));
            Ok(result)
        }

        async fn install(
            &self,
            request: DependencyRequest,
            _: CancellationToken,
            _: ExecutionContext,
            _: Arc<dyn ProgressReporter>,
        ) -> apk_domain::Result<PluginDependencies> {
            let result = view(request.target.clone());
            self.changes
                .lock()
                .unwrap()
                .push(("dependency.install".into(), request));
            Ok(result)
        }
    }

    fn setup(configured: bool) -> (Arc<Application>, Router, Arc<Store>) {
        let store = Arc::new(Store::default());
        let dependencies = DependencyService::new(store.clone());
        let app = Application::new(
            Arc::new(SqliteStore::open(":memory:").unwrap()),
            vec![Arc::new(DependencyOperations(dependencies.clone()))],
            1,
            8,
        )
        .unwrap();
        let router = crate::build_router_with_dependencies(
            app.clone(),
            "dependency-test-token".into(),
            1000,
            crate::mcp::default_config(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            configured.then_some(dependencies),
        )
        .unwrap();
        (app, router, store)
    }

    async fn request(
        router: &Router,
        method: &str,
        path: &str,
        body: Value,
        authorized: bool,
    ) -> (StatusCode, String, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if authorized {
            request = request.header("authorization", "Bearer dependency-test-token");
        }
        let response = router
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let log_id = response.headers()["x-deviceforge-log-id"]
            .to_str()
            .unwrap()
            .to_owned();
        uuid::Uuid::parse_str(&log_id).unwrap();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["log_id"], log_id);
        (status, log_id, value)
    }

    #[tokio::test]
    async fn http_routes_use_auth_envelopes_and_shared_target_service() {
        let (app, router, _) = setup(true);
        for kind in ["release", "server", "browser"] {
            let path = format!("/api/v2/plugin-dependencies/{kind}/demo");
            let (status, _, denied) = request(&router, "GET", &path, Value::Null, false).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert_eq!(denied["error"]["code"], "unauthorized");
            let (status, _, result) = request(&router, "GET", &path, Value::Null, true).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(result["data"]["target"], json!({"kind":kind,"id":"demo"}));
        }
        for (path, expected) in [
            (
                "/api/v2/plugin-dependencies/other/demo",
                StatusCode::BAD_REQUEST,
            ),
            (
                "/api/v2/plugin-dependencies/server/missing",
                StatusCode::NOT_FOUND,
            ),
        ] {
            assert_eq!(
                request(&router, "GET", path, Value::Null, true).await.0,
                expected
            );
        }
        app.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn http_changes_submit_registered_jobs_and_reject_body_target_overrides() {
        let (app, router, store) = setup(true);
        for action in ["scan", "install"] {
            let path = format!("/api/v2/plugin-dependencies/server/demo/{action}");
            let body = json!({"expected_revision":"a".repeat(64),"dependency_ids":["java"]});
            assert_eq!(
                request(&router, "POST", &path, body.clone(), false).await.0,
                StatusCode::UNAUTHORIZED
            );
            let (status, _, submitted) = request(&router, "POST", &path, body, true).await;
            assert_eq!(status, StatusCode::ACCEPTED);
            assert_eq!(
                submitted["data"]["operation"],
                format!("dependency.{action}")
            );
            let id = submitted["data"]["id"].as_str().unwrap().to_owned();
            let finished = tokio::time::timeout(std::time::Duration::from_secs(2), async {
                loop {
                    let job = app.get_async(id.clone()).await.unwrap();
                    let value = serde_json::to_value(job).unwrap();
                    if value["status"] == "succeeded" || value["status"] == "failed" {
                        break value;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(finished["status"], "succeeded");
            assert_eq!(finished["result"]["target"]["id"], "demo");
            let invalid =
                json!({"expected_revision":"a".repeat(64),"target":{"kind":"server","id":"other"}});
            assert_eq!(
                request(&router, "POST", &path, invalid, true).await.0,
                StatusCode::BAD_REQUEST
            );
        }
        {
            let changes = store.changes.lock().unwrap();
            assert_eq!(changes.len(), 2);
            assert_eq!(changes[0].0, "dependency.scan");
            assert_eq!(changes[1].0, "dependency.install");
            assert_eq!(changes[0].1.dependency_ids, vec!["java"]);
        }
        app.shutdown().await.unwrap();
    }

    async fn rpc(router: &Router, method: &str, mut params: Value) -> Value {
        params["_meta"] = json!({
            "io.modelcontextprotocol/protocolVersion":"2026-07-28",
            "io.modelcontextprotocol/clientInfo":{"name":"dependency-tests","version":"1"},
            "io.modelcontextprotocol/clientCapabilities":{}
        });
        let mut request = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("host", "127.0.0.1:7031")
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("authorization", "Bearer dependency-test-token")
            .header("MCP-Protocol-Version", "2026-07-28")
            .header("Mcp-Method", method);
        if let Some(name) = params["name"].as_str() {
            request = request.header("Mcp-Name", name);
        }
        let response = router
            .clone()
            .oneshot(
                request
                    .body(Body::from(
                        json!({
                            "jsonrpc":"2.0","id":1,"method":method,"params":params
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let log_id = response.headers()["x-deviceforge-log-id"]
            .to_str()
            .unwrap()
            .to_owned();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["result"]["_meta"]["deviceforge/log_id"], log_id);
        value["result"].clone()
    }

    #[tokio::test]
    async fn mcp_discovery_query_and_generic_jobs_share_the_dependency_service() {
        let (app, router, _) = setup(true);
        let catalog = rpc(&router, "tools/list", json!({})).await;
        let tools = catalog["tools"].as_array().unwrap();
        for name in [
            "deviceforge.get_plugin_dependencies",
            "dependency.scan",
            "dependency.install",
        ] {
            assert!(tools.iter().any(|tool| tool["name"] == name));
        }
        let target = json!({"kind":"browser","id":"demo"});
        let query = rpc(
            &router,
            "tools/call",
            json!({
                "name":"deviceforge.get_plugin_dependencies","arguments":{"target":target}
            }),
        )
        .await;
        assert_eq!(query["isError"], false);
        assert_eq!(query["structuredContent"]["target"], target);
        for name in ["dependency.scan", "dependency.install"] {
            let submitted = rpc(&router, "tools/call", json!({
                "name":name,"arguments":{"target":target,"expected_revision":"a".repeat(64),"dependency_ids":[]}
            })).await;
            assert_eq!(submitted["isError"], false);
            assert_eq!(submitted["structuredContent"]["operation"], name);
        }
        let invalid = rpc(&router, "tools/call", json!({
            "name":"deviceforge.get_plugin_dependencies","arguments":{"target":{"kind":"unknown","id":"demo"}}
        })).await;
        assert_eq!(invalid["isError"], true);
        app.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn optional_dependency_service_preserves_unconfigured_router_behavior() {
        let (app, router, _) = setup(false);
        let path = "/api/v2/plugin-dependencies/server/demo";
        let (status, _, result) = request(&router, "GET", path, Value::Null, true).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(result["error"]["code"], "not_configured");
        for action in ["scan", "install"] {
            let body = json!({"expected_revision":"a".repeat(64)});
            assert_eq!(
                request(&router, "POST", &format!("{path}/{action}"), body, true)
                    .await
                    .0,
                StatusCode::SERVICE_UNAVAILABLE
            );
        }
        let catalog = rpc(&router, "tools/list", json!({})).await;
        assert!(
            !catalog["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|tool| tool["name"] == "deviceforge.get_plugin_dependencies")
        );
        let legacy = crate::router(app.clone(), String::new(), 1000).unwrap();
        assert_eq!(
            request(&legacy, "GET", "/api/v2/health", Value::Null, false)
                .await
                .0,
            StatusCode::OK
        );
        app.shutdown().await.unwrap();
    }

    #[test]
    fn target_kinds_and_identity_follow_public_contract() {
        for kind in [
            DependencyTargetKind::Release,
            DependencyTargetKind::Server,
            DependencyTargetKind::Browser,
        ] {
            let parsed = target(Ok(Path((kind, "demo.plugin".into())))).ok().unwrap();
            assert_eq!(parsed.kind, kind);
            assert_eq!(parsed.id, "demo.plugin");
        }
        assert!(target(Ok(Path((DependencyTargetKind::Server, "../escape".into())))).is_err());
    }

    #[test]
    fn query_and_change_reject_extra_fields() {
        let query = serde_json::json!({"target":{"kind":"server","id":"demo"}});
        assert!(serde_json::from_value::<DependencyQuery>(query).is_ok());
        for value in [
            serde_json::json!({"target":{"kind":"other","id":"demo"}}),
            serde_json::json!({"target":{"kind":"server","id":"demo","path":"x"}}),
            serde_json::json!({"target":{"kind":"server","id":"demo"},"extra":true}),
        ] {
            assert!(serde_json::from_value::<DependencyQuery>(value).is_err());
        }
        assert!(
            serde_json::from_value::<DependencyChange>(serde_json::json!({
                "expected_revision":"a".repeat(64), "target":{"kind":"server","id":"other"}
            }))
            .is_err()
        );
    }
}
