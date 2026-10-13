use crate::{
    assistant_runtime,
    config::Config,
    coordinator::{self, Call},
    deployment::Deployment,
    model::{self, Operation, TurnInput},
    public_results::SessionResult,
    resources::Resources,
    runtime_status,
};
use apk_plugin_sdk::Request;
use deviceforge_plugin_runtime::{Execution, InvocationContext};
use std::{path::PathBuf, sync::Arc};

pub async fn execute(
    request: Request,
    context: InvocationContext,
    deployment: Deployment,
) -> Execution {
    let operation = match model::parse(&request.operation, request.input) {
        Ok(operation) => operation,
        Err(error) => return Execution::complete(Err(error)),
    };
    if matches!(operation, Operation::Status) {
        let config = match deployment.load_config().await {
            Ok(config) => Some(Arc::new(config)),
            Err(error) => {
                return Execution::complete(
                    serde_json::to_value(runtime_status::unavailable(error))
                        .map_err(|_| "SDK运行状态编码失败".into())
                        .map(Into::into),
                );
            }
        };
        let worker = deployment.worker_entry().await;
        let report = runtime_status::status(config, context, worker).await;
        return Execution {
            outcome: serde_json::to_value(report.status)
                .map_err(|_| "SDK运行状态编码失败".into())
                .map(Into::into),
            cleanup: report.cleanup,
        };
    }
    let config = match deployment.load_config().await {
        Ok(config) => Arc::new(config),
        Err(error) => return Execution::complete(Err(error)),
    };
    let result: Result<serde_json::Value, String> = match operation {
        Operation::Single(input) | Operation::Turn(input) => {
            let worker = match deployment.worker_entry().await {
                Ok(worker) => worker,
                Err(error) => return Execution::complete(Err(error)),
            };
            return turn(config, context, worker, input).await;
        }
        Operation::Get(input) => session(config, context, input, false).await,
        Operation::Close(input) => session(config, context, input, true).await,
        Operation::Assistant(input) => {
            let worker = match deployment.worker_entry().await {
                Ok(worker) => worker,
                Err(error) => return Execution::complete(Err(error)),
            };
            let report = assistant_runtime::run(config, context, worker, input).await;
            return Execution {
                outcome: report
                    .outcome
                    .and_then(|result| {
                        serde_json::to_value(result).map_err(|_| "SDK助手结果编码失败".into())
                    })
                    .map(Into::into),
                cleanup: report.cleanup,
            };
        }
        Operation::Stream(_) | Operation::Status => Err("SDK流或状态操作不属于普通任务".into()),
    };
    Execution::complete(result.map(Into::into))
}

async fn turn(
    config: Arc<Config>,
    context: InvocationContext,
    worker: PathBuf,
    input: TurnInput,
) -> Execution {
    let result = coordinator::run(
        config,
        context,
        worker,
        Call {
            input,
            output_schema: None,
            writer: None,
        },
    )
    .await;
    Execution {
        outcome: result
            .outcome
            .and_then(|success| {
                serde_json::to_value(success.result).map_err(|_| "SDK轮次结果编码失败".into())
            })
            .map(Into::into),
        cleanup: result.cleanup,
    }
}

async fn session(
    config: Arc<Config>,
    context: InvocationContext,
    input: model::ThreadInput,
    close: bool,
) -> Result<serde_json::Value, String> {
    let project_root = config.project(&input.project_id)?.to_owned();
    let snapshot = Resources::inspect(
        config,
        context,
        input.project_id,
        project_root,
        input.thread_id,
        close,
    )
    .await?;
    serde_json::to_value(SessionResult {
        provider: model::PROVIDER,
        sdk_version: model::SDK_VERSION,
        profile: model::PROFILE,
        project_id: snapshot.project_id,
        thread_id: snapshot.thread_id,
        turns: snapshot.turns.to_string(),
        closed: snapshot.closed,
        uncertain: snapshot.uncertain,
        resource_scope: "sdk_worker_proxy_and_cli",
    })
    .map_err(|_| "SDK会话结果编码失败".into())
}
