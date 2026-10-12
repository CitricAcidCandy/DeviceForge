//! CLI 请求与持久会话业务使用既有任务取消和固定期限。
mod config;
mod model;
mod sessions;
mod turns;
use apk_plugin_sdk::{Request, cooperative::CleanupOutcome};
use deviceforge_plugin_runtime::{Execution, InvocationContext, Output};
use serde_json::json;

pub async fn execute(request: Request, context: InvocationContext) -> Execution {
    let mut cleanup = CleanupOutcome::Complete;
    let result=async{
        context.check().map_err(|error|error.to_string())?;
        let config=config::read().await?;
        if request.operation=="runtime.status" {
            if request.input!=json!({}){return Err("运行状态输入必须为空对象".into());}
            return Ok(Output::from(json!({"configured":true,"projects":config.projects.keys().collect::<Vec<_>>(),"provider":"codex_cli"})));
        }
        turns::execute(request,config,&context,&mut cleanup).await
    }.await;
    Execution {
        outcome: result,
        cleanup,
    }
}
