mod config;
mod error;
mod lifecycle;
mod operation;
mod session;

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
    let profile_name = match operation::parse(&request) {
        Ok(name) => name,
        Err(error) => return Execution::complete(Err(error.to_string())),
    };
    let config = match config::Config::read(&context).await {
        Ok(config) => config,
        Err(error) => return Execution::complete(Err(error.to_string())),
    };
    let profile = match config.profile(&profile_name) {
        Ok(profile) => profile,
        Err(error) => return Execution::complete(Err(error.to_string())),
    };
    session::run(profile_name, profile, context, input, output).await
}

#[cfg(test)]
mod tests;
