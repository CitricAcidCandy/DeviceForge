use crate::config::Config;
use crate::{
    coordinator::{self, Call},
    model::TurnInput,
    stream::output::Writer,
};
use deviceforge_plugin_runtime::{Execution, InvocationContext, SessionInput, SessionOutput};
use std::path::PathBuf;
use std::sync::Arc;

pub async fn run(
    config: Arc<Config>,
    context: InvocationContext,
    worker: PathBuf,
    input: TurnInput,
    output: SessionOutput,
) -> Execution {
    let writer = Writer::new(output);
    let result = coordinator::run(
        config,
        context.clone(),
        worker,
        Call {
            input,
            output_schema: None,
            writer: Some(writer),
        },
    )
    .await;
    match result.outcome {
        Ok(success) => Execution {
            outcome: serde_json::to_value(success.result)
                .map(Into::into)
                .map_err(|_| "SDK会话成功结果编码失败".into()),
            cleanup: result.cleanup,
        },
        Err(error) => Execution {
            outcome: Err(error),
            cleanup: result.cleanup,
        },
    }
}

pub async fn serve(_input: SessionInput, _context: InvocationContext) -> Result<(), String> {
    Err("SDK会话输入须由运行库生命周期接管".into())
}
