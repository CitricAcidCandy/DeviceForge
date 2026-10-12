//! 设备动作、本机鼠标与输入轨迹通过公开协议接入同一任务生命周期。
mod android;
mod config;
mod control;
mod error;
mod files;
mod input;
mod model;
mod mouse;
mod msgpack;
mod native;
mod trace;
use apk_plugin_sdk::{Request, cooperative::CleanupOutcome};
use control::Control;
use deviceforge_plugin_runtime::{Execution, InvocationContext, Output};
use error::{Error, Result};
use input::Operation;

pub async fn execute(request: Request, context: InvocationContext) -> Execution {
    let control = Control::new(context);
    let result = run(&request, &control).await;
    let cleanup = match control.finish(result.is_ok()).await {
        Ok(()) => CleanupOutcome::Complete,
        Err(_) => CleanupOutcome::Failed,
    };
    Execution {
        outcome: result.map_err(|error| error.to_string()),
        cleanup,
    }
}

async fn run(request: &Request, control: &Control) -> Result<Output> {
    control.check()?;
    let operation = input::parse(&request.operation, &request.input)?;
    let config = control
        .work(|context, _| config::Config::read(|| context.check().map_err(Into::into)))
        .await?;
    match operation {
        Operation::Android => {
            android::run(
                control,
                request,
                config
                    .adb
                    .as_deref()
                    .ok_or(Error::Dependency("尚未配置ADB工具"))?,
            )
            .await
        }
        Operation::Position => {
            config.desktop()?;
            mouse::position(control).map(Output::from)
        }
        Operation::Click(value) => {
            config.desktop()?;
            mouse::click(control, value).map(Output::from)
        }
        Operation::Repeat(value) => {
            config.desktop()?;
            mouse::repeat(control, value).await.map(Output::from)
        }
        Operation::Record(value) => trace::record(control, request, &config, value).await,
        Operation::Playback(value) => trace::playback(control, request, &config, value).await,
    }
}
