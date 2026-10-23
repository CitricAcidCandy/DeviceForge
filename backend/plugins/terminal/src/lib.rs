mod config;
mod control;
mod error;
mod lifecycle;
mod operation;
mod session;
mod terminal;

use apk_plugin_sdk::session::SessionOpen;
use deviceforge_plugin_runtime::{
    Execution, InvocationContext,
    session::{SessionInput, SessionOutput},
};
pub(crate) use error::{Error, Result};

pub async fn execute(
    request: SessionOpen,
    context: InvocationContext,
    input: SessionInput,
    output: SessionOutput,
) -> Execution {
    if let Err(error) = context.check() {
        return Execution::complete(Err(error.to_string()));
    }
    let open = match operation::parse(&request) {
        Ok(open) => open,
        Err(error) => return Execution::complete(Err(error.to_string())),
    };
    let config = match config::Config::read(&context).await {
        Ok(config) => config,
        Err(error) => return Execution::complete(Err(error.to_string())),
    };
    let profile = match config.profile(&open.profile) {
        Ok(profile) => profile,
        Err(error) => return Execution::complete(Err(error.to_string())),
    };
    if let Some(terminal) = open.terminal {
        let size = match terminal.size() {
            Ok(size) => size,
            Err(error) => return Execution::complete(Err(error.to_string())),
        };
        terminal::run(open.profile, profile, size, context, input, output).await
    } else {
        session::run(open.profile, profile, context, input, output).await
    }
}

#[cfg(test)]
mod tests;
