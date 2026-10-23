use super::super::PtySize;
use super::native::Owner;
use crate::{Environment, Error, Result, ToolCommand, ownership::Lease};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs::{File, OpenOptions},
    os::windows::ffi::OsStrExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

static NEXT_PIPE: AtomicU64 = AtomicU64::new(1);

pub(super) struct Specification {
    pub command: Vec<u16>,
    pub environment: Vec<u16>,
    pub directory: Option<Vec<u16>>,
}

fn wide(value: &std::ffi::OsStr) -> Result<Vec<u16>> {
    let mut value: Vec<u16> = value.encode_wide().collect();
    if value.contains(&0) {
        return Err(Error::InvalidOptions("终端参数包含空字符"));
    }
    value.push(0);
    Ok(value)
}

fn quote(value: &str) -> String {
    let mut quoted = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        if ch == '"' {
            quoted.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
        } else {
            quoted.extend(std::iter::repeat_n('\\', slashes));
        }
        slashes = 0;
        quoted.push(ch);
    }
    quoted.extend(std::iter::repeat_n('\\', slashes * 2));
    quoted.push('"');
    quoted
}

impl Specification {
    pub(super) fn new(spec: ToolCommand<'_>) -> Result<Self> {
        let mut values: BTreeMap<OsString, OsString> =
            if spec.environment == Environment::Restricted {
                crate::restricted_environment()
            } else {
                std::env::vars_os().collect()
            };
        values.extend(spec.env);
        values.insert("TERM".into(), "xterm-256color".into());
        values.insert("COLORTERM".into(), "truecolor".into());
        let mut entries: Vec<_> = values.into_iter().collect();
        entries.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
        let mut environment = Vec::new();
        for (key, value) in entries {
            let mut entry = key;
            entry.push("=");
            entry.push(value);
            environment.extend(wide(&entry)?);
        }
        environment.push(0);
        let command = std::iter::once(spec.executable)
            .chain(spec.args.iter().map(String::as_str))
            .map(quote)
            .collect::<Vec<_>>()
            .join(" ");
        let directory = spec
            .directory
            .map(|path| wide(path.as_os_str()))
            .transpose()?;
        Ok(Self {
            command: wide(std::ffi::OsStr::new(&command))?,
            environment,
            directory,
        })
    }
}

pub(super) struct Pipes {
    pub input: NamedPipeServer,
    pub output: NamedPipeServer,
}

pub(super) struct Endpoints {
    pipes: Pipes,
    input: File,
    output: File,
}

impl Endpoints {
    pub(super) async fn new() -> Result<Self> {
        let unique = format!(
            "deviceforge-pty-{}-{}",
            std::process::id(),
            NEXT_PIPE.fetch_add(1, Ordering::Relaxed)
        );
        let input_name = PathBuf::from(format!(r"\\.\pipe\{unique}-in"));
        let output_name = PathBuf::from(format!(r"\\.\pipe\{unique}-out"));
        let input = ServerOptions::new()
            .access_inbound(false)
            .access_outbound(true)
            .first_pipe_instance(true)
            .create(&input_name)
            .map_err(Error::ProcessIo)?;
        let output = ServerOptions::new()
            .access_inbound(true)
            .access_outbound(false)
            .first_pipe_instance(true)
            .create(&output_name)
            .map_err(Error::ProcessIo)?;
        let (input_client, output_client) = tokio::task::spawn_blocking(move || {
            Ok::<_, std::io::Error>((
                OpenOptions::new().read(true).open(input_name)?,
                OpenOptions::new().write(true).open(output_name)?,
            ))
        })
        .await
        .map_err(|error| Error::ProcessIo(std::io::Error::other(error)))?
        .map_err(Error::ProcessIo)?;
        tokio::try_join!(input.connect(), output.connect()).map_err(Error::ProcessIo)?;
        Ok(Self {
            pipes: Pipes { input, output },
            input: input_client,
            output: output_client,
        })
    }

    pub(super) fn launch(
        self,
        spec: Specification,
        size: PtySize,
        lease: Lease,
        options: &crate::ExecutionOptions,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<(Owner, Pipes, Option<Error>)> {
        let (owner, failure) = Owner::launch(
            spec,
            size,
            &self.input,
            &self.output,
            lease,
            options,
            cancel,
        )?;
        Ok((owner, self.pipes, failure))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn argv_quote_preserves_spaces_quotes_and_trailing_slashes() {
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("a b"), "\"a b\"");
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote("a\\"), "\"a\\\\\"");
    }
}
