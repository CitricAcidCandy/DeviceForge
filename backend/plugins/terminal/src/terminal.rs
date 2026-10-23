use crate::{
    Error, Result,
    config::Profile,
    control::{self, Message},
    lifecycle::Lifecycle,
};
use apk_plugin_sdk::session::SessionStream;
use deviceforge_plugin_runtime::{
    Execution, InvocationContext,
    session::{SessionInput, SessionOutput},
};
use deviceforge_tool_process::{
    Environment, ExecutionOptions, PtyInput, PtySize, StreamOptions, ToolCommand,
    spawn_pty_with_lease,
};

async fn forward(mut input: SessionInput, tool: PtyInput) -> Result<()> {
    while let Some(bytes) = input.recv().await? {
        match control::parse(&bytes)? {
            Message::Input { text } => tool
                .send(text.as_bytes())
                .await
                .map_err(|_| Error::Closed)?,
            Message::Resize { cols, rows } => tool
                .resize(PtySize::new(cols, rows).map_err(|_| Error::Invalid("终端尺寸无效"))?)
                .await
                .map_err(|_| Error::Closed)?,
        }
    }
    tool.close().await.map_err(|_| Error::Closed)
}

pub(crate) async fn run(
    profile_name: String,
    profile: &Profile,
    size: PtySize,
    context: InvocationContext,
    input: SessionInput,
    output: SessionOutput,
) -> Execution {
    if let Err(error) = context.check() {
        return Execution::complete(Err(error.to_string()));
    }
    let lifecycle = Lifecycle::default();
    let mut command = ToolCommand::new(&profile.executable, &profile.args);
    command.environment = Environment::Restricted;
    command.directory = profile.directory.as_deref();
    let mut execution = ExecutionOptions::new(context.deadline().into());
    execution.stdout_limit = 16 * 1024 * 1024;
    let options = StreamOptions::new(execution);
    let mut process = match spawn_pty_with_lease(
        command,
        options,
        size,
        context.cancellation(),
        lifecycle.lease.clone(),
    )
    .await
    {
        Ok(process) => process,
        Err(error) => return lifecycle.finish(profile_name, Err(error), None),
    };
    let incoming = forward(input, process.input());
    tokio::pin!(incoming);
    let cancel = context.cancellation();
    let mut input_done = false;
    let cause = loop {
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(context.deadline().into()) => break Some(Error::Timeout),
            _ = cancel.cancelled() => break Some(Error::Cancelled),
            chunk = process.recv() => {
                let Some(chunk) = chunk else { break None; };
                if let Err(error) = output.send(SessionStream::Stdout, &chunk.bytes).await { break Some(Error::from(error)); }
            },
            result = &mut incoming, if !input_done => {
                match result { Ok(()) => input_done = true, Err(error) => break Some(error) }
            },
        }
    };
    if cause.is_some() {
        process.cancel();
    }
    let result = process.wait().await;
    let cause = context.check().err().map(Error::from).or(cause);
    lifecycle.finish(profile_name, result, cause)
}
