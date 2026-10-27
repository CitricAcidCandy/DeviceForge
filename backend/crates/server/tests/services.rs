use apk_application::Application;
use apk_domain::{Executor, Operation, services::*};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

struct Echo;
#[async_trait]
impl Executor for Echo {
    fn operations(&self) -> Vec<Operation> {
        vec![Operation {
            id: "demo.echo".into(),
            title: "服务回显".into(),
            input_schema: json!({"type":"object"}),
            execution: None,
        }]
    }
    fn services(&self) -> ServiceAccess {
        ServiceAccess {
            provided: vec![ProvidedService {
                service: ServiceRef {
                    id: "demo.echo".into(),
                    version: "1.0".into(),
                },
                operation: "demo.echo".into(),
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
        value: Value,
        _: CancellationToken,
    ) -> apk_domain::Result<Value> {
        Ok(value)
    }
}
async fn request(
    router: &axum::Router,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    (
        status,
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap(),
    )
}
#[tokio::test]
async fn public_catalog_and_call_return_v2_envelopes_and_existing_202_job() {
    let app = Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![Arc::new(Echo)],
        1,
        8,
    )
    .unwrap();
    let router = apk_server::router(app.clone(), String::new(), 100).unwrap();
    let (status, catalog) = request(&router, "GET", "/api/v2/services", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert!(catalog["log_id"].is_string());
    assert_eq!(
        catalog["data"][0]["service"],
        json!({"id":"demo.echo","version":"1.0"})
    );
    for (version, status) in [
        (json!("1.0"), StatusCode::ACCEPTED),
        (json!("1"), StatusCode::NOT_FOUND),
        (json!(1), StatusCode::BAD_REQUEST),
        (json!(""), StatusCode::BAD_REQUEST),
    ] {
        let (actual, value) = request(
            &router,
            "POST",
            "/api/v2/services/demo.echo/calls",
            json!({"version":version,"input":{}}),
        )
        .await;
        assert_eq!(actual, status);
        assert!(value["log_id"].is_string());
        if actual == StatusCode::ACCEPTED {
            assert_eq!(value["data"]["operation"], "demo.echo");
            assert!(value["data"]["id"].is_string());
        }
    }
    app.shutdown().await.unwrap();
}
#[test]
fn openapi_exposes_frozen_nodes_and_string_versions() {
    let document = apk_server::openapi_document();
    for name in [
        "ServiceRef",
        "ServiceContract",
        "ServiceProvider",
        "ServiceInfo",
        "ServiceCallRequest",
    ] {
        assert!(document["components"]["schemas"][name].is_object());
    }
    assert_eq!(
        document["components"]["schemas"]["ServiceRef"]["properties"]["version"]["type"],
        "string"
    );
    assert_eq!(
        document["components"]["schemas"]["ServiceCallRequest"]["properties"]["version"]["type"],
        "string"
    );
    assert!(
        document["paths"]["/api/v2/services/{id}/calls"]["post"]["responses"]["202"].is_object()
    );
}
