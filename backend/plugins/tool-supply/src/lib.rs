//! 独立工具供应业务插件，只依赖公开插件协议和运行库。
mod budget;
mod cache;
mod config;
mod error;
mod feature;
mod input;
mod local_import;
mod manifest;
mod network;
mod operations;
mod storage;
mod transaction;
mod unpack;

use apk_plugin_sdk::{Request, cooperative::CleanupOutcome};
use deviceforge_plugin_runtime::{Execution, InvocationContext};

pub async fn execute(request: Request, context: InvocationContext) -> Execution {
    let budget = budget::Budget {
        deadline: context.deadline(),
        cancel: context.cancellation(),
    };
    // 每调用只有一个文件事务工作者；协议取消接收器不被文件锁、ZIP或提交阻塞。
    // 网络仍使用异步客户端，工作者沿用原绝对期限和同一取消信号。
    let worker = tokio::task::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| error::Error::Io("无法创建工具供应事务工作者"))?;
        runtime.block_on(async move {
            budget.check()?;
            if request.operation == "import" {
                let input = local_import::parse(request.input)?;
                let config = config::Config::read(&budget)?;
                return local_import::execute(input, request.artifacts, &config, &budget).await;
            }
            let input = input::parse(&request.operation, request.input)?;
            let config = config::Config::read(&budget)?;
            operations::execute(input, &config, &budget).await
        })
    })
    .await;
    let outcome = match worker {
        Ok(outcome) => outcome,
        Err(_) => {
            return Execution {
                outcome: Err("工具供应事务工作异常，清理未确认".into()),
                cleanup: CleanupOutcome::Failed,
            };
        }
    };
    match outcome {
        Err(error::Error::Cleanup) => Execution {
            outcome: Err(error::Error::Cleanup.to_string()),
            cleanup: CleanupOutcome::Failed,
        },
        outcome => Execution::complete(outcome.map(Into::into).map_err(|error| error.to_string())),
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod feature_tests;

#[cfg(test)]
mod source_tests;
