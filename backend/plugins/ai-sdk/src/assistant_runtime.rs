use crate::{
    assistant::{Next, Plan},
    config::Config,
    coordinator::{self, Call},
    model::{AssistantInput, TurnInput},
    public_results::AssistantResult,
};
use apk_plugin_sdk::cooperative::CleanupOutcome;
use deviceforge_plugin_runtime::InvocationContext;
use std::{path::PathBuf, sync::Arc};

pub struct Report {
    pub outcome: Result<AssistantResult, String>,
    pub cleanup: CleanupOutcome,
}

pub async fn run(
    config: Arc<Config>,
    context: InvocationContext,
    worker: PathBuf,
    input: AssistantInput,
) -> Report {
    let mut cleanup = CleanupOutcome::Complete;
    let outcome = run_plan(config, context, worker, input, &mut cleanup).await;
    Report { outcome, cleanup }
}

async fn run_plan(
    config: Arc<Config>,
    context: InvocationContext,
    worker: PathBuf,
    input: AssistantInput,
    cleanup: &mut CleanupOutcome,
) -> Result<AssistantResult, String> {
    let (mut plan, first) = Plan::new(&input)?;
    let mut prompt = first;
    let mut final_answer = None;
    let mut thread_id = None;
    let mut turns = 0u64;
    while final_answer.is_none() {
        context.check().map_err(|error| error.to_string())?;
        if turns >= crate::assistant::MAX_TURNS as u64 {
            return Err("测试助手四轮内没有完整最终回答".into());
        }
        let turn = coordinator::run(
            config.clone(),
            context.clone(),
            worker.clone(),
            Call {
                input: TurnInput {
                    project_id: input.project_id.clone(),
                    prompt: prompt.clone(),
                    thread_id: None,
                },
                output_schema: Some(crate::assistant::schema()),
                writer: None,
            },
        )
        .await;
        *cleanup = turn.cleanup;
        let turn = turn.outcome?;
        turns += 1;
        if thread_id.is_none() {
            thread_id = Some(turn.result.thread_id.clone());
        }
        match plan.advance(&turn.result.text)? {
            Next::Final(answer) => final_answer = Some(answer),
            Next::Continue(next) => prompt = next,
        }
    }
    let answer = final_answer.ok_or("测试助手缺少最终回答")?;
    Ok(AssistantResult {
        turn: crate::model::TurnResult {
            provider: turn_provider(),
            sdk_version: crate::model::SDK_VERSION,
            project_id: input.project_id,
            thread_id: thread_id.ok_or("测试助手缺少线程")?,
            text: answer,
            turns: turns.to_string(),
            resource_scope: "sdk_worker_proxy_and_cli",
        },
        assistant_turns: turns.to_string(),
        stream_output: input.stream_output,
    })
}

const fn turn_provider() -> &'static str {
    crate::model::PROVIDER
}
