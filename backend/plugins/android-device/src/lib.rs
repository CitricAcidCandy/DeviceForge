//! 独立Android设备插件；业务仅经公开协议和工具执行库接入。
mod config;
mod control;
mod discovery;
mod error;
mod operations;
mod rules;
mod session;

use apk_plugin_sdk::Request;
pub(crate) use control::Control;
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
    if let Err(error) = session::validate_context(&request, &input) {
        return Execution::complete(Err(error.to_string()));
    }
    let config = match config::Config::read(&context).await {
        Ok(config) => config,
        Err(error) => return Execution::complete(Err(error.to_string())),
    };
    let executable = match config.command(&context).await {
        Ok(executable) => executable,
        Err(error) => return Execution::complete(Err(error.to_string())),
    };
    let control = Control::new(context, executable);
    if matches!(
        input,
        operations::Input::Install { .. }
            | operations::Input::InstallApks { .. }
            | operations::Input::Screenshot { .. }
            | operations::Input::Performance { .. }
    ) {
        return session::Session::execute(control, config, &request, input).await;
    }
    let result = operations::execute(&control, input).await;
    control.finish(result)
}
