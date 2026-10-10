//! 独立Android设备插件；业务仅经公开协议和工具执行库接入。
mod config;
mod control;
mod discovery;
mod error;
mod operations;
mod rules;

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
    // 宿主协议4也为非产物操作提供空上下文；只有真实输入产物越出本批声明。
    if request
        .artifacts
        .as_ref()
        .is_some_and(|artifacts| !artifacts.inputs.is_empty())
    {
        return Execution::complete(Err(Error::Invalid("本批设备操作不接受输入产物").to_string()));
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
    let result = operations::execute(&control, input).await;
    control.finish(result)
}
