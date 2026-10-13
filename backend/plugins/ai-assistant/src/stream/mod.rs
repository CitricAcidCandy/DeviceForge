mod events;
mod output;
mod process;
mod state;
mod worker;

use crate::{config, model};
use apk_plugin_sdk::{cooperative::CleanupOutcome, session::SessionOpen};
use deviceforge_plugin_runtime::{
    Execution, InvocationContext,
    session::{SessionInput, SessionOutput},
};
use std::sync::Arc;

struct Guard<'a> {
    resources: &'a Arc<state::Resources>,
    finished: bool,
}

impl Drop for Guard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.resources.fail_cleanup();
        }
    }
}

pub async fn execute(
    open: SessionOpen,
    context: InvocationContext,
    input: SessionInput,
    output: SessionOutput,
) -> Execution {
    execute_configured(open, context, input, output, config::read()).await
}

async fn execute_configured<Configure>(
    open: SessionOpen,
    context: InvocationContext,
    input: SessionInput,
    output: SessionOutput,
    configure: Configure,
) -> Execution
where
    Configure: std::future::Future<Output = Result<config::Config, String>>,
{
    let resources = Arc::new(state::Resources::default());
    let mut guard = Guard {
        resources: &resources,
        finished: false,
    };
    let outcome = async {
        context.check().map_err(|error| error.to_string())?;
        if open.operation != "cli.stream" {
            return Err("未知AI会话操作".into());
        }
        if open.artifacts.as_ref().is_some_and(|artifacts| {
            !artifacts.inputs.is_empty() || artifacts.output_directory.is_some()
        }) {
            return Err("AI流会话不接受产物读写权限".into());
        }
        let turn = model::parse(open.input)?;
        let config = configure.await?;
        process::run(config, turn, context, resources.clone(), input, output).await
    }
    .await;
    guard.finished = true;
    let cleanup = if resources.cleanup_failed() || Arc::strong_count(&resources) != 1 {
        CleanupOutcome::Failed
    } else {
        CleanupOutcome::Complete
    };
    Execution { outcome, cleanup }
}

#[cfg(test)]
mod tests;
