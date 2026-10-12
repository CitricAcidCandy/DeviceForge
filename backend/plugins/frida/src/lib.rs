//! 独立Frida业务插件，只依赖公共插件协议、运行库与工具执行库。
mod artifacts;
mod config;
mod control;
mod error;
mod files;
mod input;
mod permissions;
mod processes;
mod script;
mod server;
use apk_plugin_sdk::{Request, cooperative::CleanupOutcome};
use deviceforge_plugin_runtime::{Execution, InvocationContext, Output};
pub(crate) use error::{Error, Result};
use input::Operation;

pub async fn execute(request: Request, context: InvocationContext) -> Execution {
    let control = control::Control::new(context);
    let result = execute_inner(&control, &request).await;
    let result = match control.context.check() {
        Ok(()) => result,
        Err(error) => Err(error.into()),
    };
    if control.finish(result.is_ok()).await.is_err() {
        control.failed();
        return Execution {
            outcome: Err(Error::CleanupFailed.to_string()),
            cleanup: CleanupOutcome::Failed,
        };
    }
    Execution::complete(result.map_err(|error| error.to_string()))
}
async fn execute_inner(control: &control::Control, request: &Request) -> Result<Output> {
    control.check()?;
    let input = input::parse(&request.operation, &request.input)?;
    artifacts::validate(request, &input.operation)?;
    let config = control
        .work(|context, _| config::Config::read(|| context.check().map_err(Into::into)))
        .await?;
    let directory = control.directory(config.scratch_root.clone()).await?;
    let device = &input.device_id;
    let (value, log, extra) = match input.operation {
        Operation::Deploy(_) => {
            let source = artifacts::prepare(control, request, &directory, "server.bin").await?;
            let (value, log) = server::deploy(control, &config, device, &source).await?;
            (value, log, vec![])
        }
        Operation::Status => {
            let (value, log) = server::status(control, &config, device).await?;
            (value, log, vec![])
        }
        Operation::Run(duration) => {
            let (value, log) = server::run(control, &config, device, duration).await?;
            (value, log, vec![])
        }
        Operation::Processes => {
            let (value, log) = processes::enumerate(control, &config, device).await?;
            (value, log, vec![])
        }
        Operation::Script(input) => {
            let source = artifacts::prepare(control, request, &directory, "script.js").await?;
            let call = script::ScriptCall {
                package: &input.package,
                mode: input.mode,
                duration_ms: input.duration_ms,
                path: &source,
            };
            let result = script::run(control, &config, device, call, &directory).await?;
            let contents = script::contents(control, &source).await?;
            (
                result.value,
                result.log,
                vec![("script.js", contents), ("notices.jsonl", result.notices)],
            )
        }
        Operation::Permissions(input) => {
            let generated = permissions::generate(&input)?;
            let source = directory.join("permissions.js");
            let target = source.clone();
            let contents = generated.into_bytes();
            let bytes = contents.clone();
            control
                .work(move |context, _| {
                    files::write(&target, &bytes, || context.check().map_err(Into::into))
                })
                .await?;
            let call = script::ScriptCall {
                package: &input.package,
                mode: input.mode,
                duration_ms: input.duration_ms,
                path: &source,
            };
            let result = script::run(control, &config, device, call, &directory).await?;
            // 缺少初始化统计表示Hook未获得真实加载证据，不能把CLI正常退出写成分析成功。
            if !result.value["hook_summary"]
                .as_array()
                .is_some_and(|entries| entries.iter().any(|entry| entry["type"] == "summary"))
            {
                return Err(Error::Tool("权限脚本没有返回Hook初始化统计".into()));
            }
            (
                result.value,
                result.log,
                vec![
                    ("permissions.js", contents),
                    ("notices.jsonl", result.notices),
                ],
            )
        }
    };
    artifacts::publish(control, request, value, log, extra).await
}
