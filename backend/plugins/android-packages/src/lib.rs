//! 独立安卓包插件，只消费公开契约和公共核心，不引用宿主内部模块。
mod config;
mod error;
mod operations;
mod session;

use apk_plugin_sdk::{Request, cooperative::CleanupOutcome};
use deviceforge_plugin_runtime::{Execution, InvocationContext};
pub(crate) use error::{Error, Result};

pub async fn execute(request: Request, context: InvocationContext) -> Execution {
    if let Err(error) = context.check() {
        return Execution::complete(Err(error.to_string()));
    }
    let input = match operations::parse(&request.operation, &request.input) {
        Ok(input) => input,
        Err(error) => return Execution::complete(Err(error.to_string())),
    };
    let config = match config::Config::read(&context).await {
        Ok(config) => config,
        Err(error) => return Execution::complete(Err(error.to_string())),
    };
    let session =
        match session::Session::prepare(&request, context, config, input.extensions()).await {
            Ok(session) => session,
            Err(error @ Error::CleanupFailed) => {
                return Execution {
                    outcome: Err(error.to_string()),
                    cleanup: CleanupOutcome::Failed,
                };
            }
            Err(error) => return Execution::complete(Err(error.to_string())),
        };
    let result = operations::execute(&session, input).await;
    session.finish(result).await
}
