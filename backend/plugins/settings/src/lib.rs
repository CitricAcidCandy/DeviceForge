//! 用户与工作区配置业务；文件事务只在受限的一次阻塞工作中执行。
mod config;
mod model;
mod store;

use apk_plugin_sdk::Request;
use deviceforge_plugin_runtime::{Execution, InvocationContext, Output};

pub async fn execute(request: Request, context: InvocationContext) -> Execution {
    let result = async {
        context.check().map_err(|error| error.to_string())?;
        let input = model::parse(&request.operation, request.input)?;
        let root = config::root().await?;
        // 调用丢弃不能让已开始的文件事务失去所有权；处理器等待实际工作收口。
        tokio::task::spawn_blocking(move || store::execute(&root, input, &context))
            .await
            .map_err(|_| "配置事务工作异常".to_owned())?
    }
    .await;
    Execution::complete(result.map(Output::from))
}
