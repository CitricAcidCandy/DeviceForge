mod applications;
mod config;
mod control;
mod discovery;
mod error;
mod input;
mod network;
mod operations;
mod rules;
mod screenshot;
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
    if matches!(input, operations::Input::Screenshot { .. })
        && let Err(error) = screenshot::validate_context(&request)
    {
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
    if let operations::Input::Screenshot { device_id } = input {
        return screenshot::execute(control, config, &request, device_id).await;
    }
    if matches!(input, operations::Input::Install { .. }) {
        return session::Session::execute(control, config, &request, input).await;
    }
    let result = operations::execute(&control, input).await;
    control.finish(result)
}
