use apk_application::Application;
use apk_domain::{
    Error, ExecutionContext, Executor, Job, JobStatus, Operation, ProgressReporter, Result,
    services::*,
};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

struct Services;
fn reference(id: &str) -> ServiceRef {
    ServiceRef {
        id: id.into(),
        version: "1.0".into(),
    }
}
#[async_trait]
impl Executor for Services {
    fn operations(&self) -> Vec<Operation> {
        [
            "compose",
            "echo",
            "recursive",
            "missing",
            "free",
            "invalid",
            "capacity",
        ]
        .into_iter()
        .map(|id| Operation {
            id: format!("demo.{id}"),
            title: "服务测试".into(),
            input_schema: json!({"type":"object"}),
            execution: None,
        })
        .collect()
    }
    fn services(&self) -> ServiceAccess {
        ServiceAccess {
            provided: ["echo", "recursive", "invalid"]
                .into_iter()
                .map(|id| ProvidedService {
                    service: reference(&format!("demo.{id}")),
                    operation: format!("demo.{id}"),
                    contract: ServiceContract {
                        input_schema: json!({"type":"object"}),
                        output_schema: json!({"type":"object"}),
                    },
                })
                .collect(),
            required: vec![RequiredService {
                service: reference("absent"),
                operations: vec!["demo.missing".into()],
                sessions: vec![],
            }],
        }
    }
    async fn execute(&self, _: &str, input: Value, _: CancellationToken) -> Result<Value> {
        Ok(input)
    }
    async fn execute_with_services(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        _: ExecutionContext,
        _: Arc<dyn ProgressReporter>,
        services: Arc<dyn ServiceCaller>,
    ) -> Result<Value> {
        match operation {
            "demo.compose" => services.call(reference("demo.echo"), input, cancel).await,
            "demo.recursive" => {
                services
                    .call(reference("demo.recursive"), input, cancel)
                    .await
            }
            "demo.invalid" => Ok(json!("错误输出类型")),
            "demo.echo" if input["hold"] == true => {
                cancel.cancelled().await;
                Err(Error::Cancelled)
            }
            "demo.capacity" => {
                let child_cancel = cancel.child_token();
                let work = futures_util::future::join_all((0..5).map(|_| {
                    services.call(
                        reference("demo.echo"),
                        json!({"hold":true}),
                        child_cancel.clone(),
                    )
                }));
                let release = async {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    child_cancel.cancel();
                };
                let (result, ()) = tokio::join!(work, release);
                assert_eq!(
                    result
                        .iter()
                        .filter(|result| matches!(result, Err(Error::Conflict(_))))
                        .count(),
                    1
                );
                Ok(json!({"bounded":true}))
            }
            _ => Ok(input),
        }
    }
}
fn setup() -> Arc<Application> {
    Application::new(
        Arc::new(SqliteStore::open(":memory:").unwrap()),
        vec![Arc::new(Services)],
        1,
        8,
    )
    .unwrap()
}
async fn terminal(app: &Application, job: &Job) -> Job {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let value = app.get_async(job.id.clone()).await.unwrap();
            if value.status.is_terminal() {
                break value;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn nested_calls_do_not_reacquire_single_parent_worker_or_create_second_job() {
    let app = setup();
    let job = app
        .submit_async("demo.compose".into(), json!({"value":42}))
        .await
        .unwrap();
    let done = terminal(&app, &job).await;
    assert_eq!(done.status, JobStatus::Succeeded);
    assert_eq!(done.result, Some(json!({"value":42})));
    assert_eq!(app.list_async(10).await.unwrap().len(), 1);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn missing_exact_version_scoped_dependency_recursion_and_invalid_output_fail() {
    let app = setup();
    assert!(matches!(
        app.call_service(
            "demo.echo".into(),
            ServiceCallRequest {
                version: "1".into(),
                input: json!({}),
                generation: None
            }
        )
        .await,
        Err(Error::NotFound(_))
    ));
    assert!(
        app.submit_async("demo.missing".into(), json!({}))
            .await
            .is_err()
    );
    let free = app
        .submit_async("demo.free".into(), json!({}))
        .await
        .unwrap();
    assert_eq!(terminal(&app, &free).await.status, JobStatus::Succeeded);
    for id in ["recursive", "invalid"] {
        let job = app
            .call_service(
                format!("demo.{id}"),
                ServiceCallRequest {
                    version: "1.0".into(),
                    input: json!({}),
                    generation: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(terminal(&app, &job).await.status, JobStatus::Failed);
    }
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn fifth_parallel_descendant_is_explicitly_rejected_without_waiting_ancestors() {
    let app = setup();
    let job = app
        .submit_async("demo.capacity".into(), json!({}))
        .await
        .unwrap();
    assert_eq!(terminal(&app, &job).await.status, JobStatus::Succeeded);
    app.shutdown().await.unwrap();
}
#[tokio::test]
async fn root_cancel_propagates_to_descendants_and_preserves_job_terminal() {
    let app = setup();
    let job = app
        .submit_async("demo.compose".into(), json!({"hold":true}))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    app.cancel_async(job.id.clone()).await.unwrap();
    app.shutdown().await.unwrap();
    assert_eq!(
        app.get_async(job.id).await.unwrap().status,
        JobStatus::Cancelled
    );
}
