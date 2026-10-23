use super::super::input::Message;
use super::{launch::Pipes, native::Owner};
use crate::{Error, OutputStream, Result, StreamChunk, StreamExit, StreamOptions};
use std::{io, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
    task::JoinHandle,
    time,
};
use tokio_util::sync::CancellationToken;

fn cleanup_error(cause: Error) -> Error {
    Error::CleanupFailed {
        cause: Box::new(cause),
    }
}

pub(super) async fn run(
    owned: (Owner, Option<Error>),
    mut pipes: Pipes,
    options: StreamOptions,
    cancel: CancellationToken,
    mut input: mpsc::Receiver<Message>,
    output: mpsc::Sender<StreamChunk>,
) -> Result<StreamExit> {
    let (mut owner, mut failure) = owned;
    let mut status = None;
    let mut output_done = false;
    let mut cleanup_deadline = None;
    let mut console_close: Option<JoinHandle<()>> = None;
    let mut console_closed = false;
    let mut output_bytes = 0u64;
    let mut pending_output = None;
    let mut pending_input: Option<(Vec<u8>, usize)> = None;
    let mut buffer = vec![0u8; options.chunk_size];
    let mut poll = time::interval(Duration::from_millis(10));
    poll.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    loop {
        if cleanup_deadline.is_none() {
            if cancel.is_cancelled() {
                failure.get_or_insert(Error::Cancelled);
            }
            if time::Instant::now() >= options.execution.deadline {
                failure.get_or_insert(Error::Timeout);
            }
            match owner.status() {
                Ok(Some(value)) => status = Some(value),
                Ok(None) => {}
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
            if failure.is_some() || status.is_some() {
                cleanup_deadline = Some(time::Instant::now() + options.execution.cleanup_timeout);
                input.close();
                if let Err(error) = owner.stop() {
                    failure = Some(cleanup_error(error));
                }
                if let Some(console) = owner.console() {
                    console_close = Some(tokio::task::spawn_blocking(move || console.close()));
                } else {
                    console_closed = true;
                }
            }
        }
        if cleanup_deadline.is_some() {
            pending_input.take();
            if failure.is_some() {
                pending_output.take();
            }
            if status.is_none() {
                match owner.status() {
                    Ok(value) => status = value,
                    Err(error) => {
                        failure = Some(cleanup_error(error));
                    }
                }
            }
            let empty = match owner.empty() {
                Ok(value) => value,
                Err(error) => {
                    failure = Some(cleanup_error(error));
                    false
                }
            };
            if empty
                && (status.is_some() || owner.unstarted())
                && output_done
                && console_closed
                && pending_output.is_none()
            {
                owner.confirmed();
                cancel.cancel();
                return match failure {
                    Some(error) => Err(error),
                    None => Ok(StreamExit {
                        status: status.expect("已核对退出"),
                        stdout_bytes: output_bytes,
                        stderr_bytes: 0,
                    }),
                };
            }
        }
        let cutoff = cleanup_deadline.unwrap_or(options.execution.deadline);
        tokio::select! {
            biased;
            _ = time::sleep_until(cutoff), if cleanup_deadline.is_some() => {
                cancel.cancel();
                // 将仍在关闭的PTY和输出排空交给回收器；不把超时冒充已释放。
                tokio::spawn(reap(owner, pipes, console_close, console_closed));
                return Err(cleanup_error(failure.unwrap_or(Error::Timeout)));
            },
            _ = cancel.cancelled(), if cleanup_deadline.is_none() => {},
            _ = time::sleep_until(options.execution.deadline), if cleanup_deadline.is_none() => {},
            result = async { console_close.as_mut().expect("PTY关闭工作存在").await }, if console_close.is_some() => {
                console_close.take();
                match result {
                    Ok(()) => console_closed = true,
                    Err(error) => { failure = Some(cleanup_error(Error::ProcessIo(io::Error::other(error)))); },
                }
            },
            permit = output.reserve(), if pending_output.is_some() => {
                match permit {
                    Ok(permit) => permit.send(pending_output.take().expect("保留当前输出")),
                    Err(_) => { pending_output.take(); failure.get_or_insert(Error::Cancelled); },
                }
            },
            bytes = pipes.output.read(&mut buffer), if !output_done && pending_output.is_none() => {
                match bytes {
                    Ok(0) => output_done = true,
                    Ok(size) => {
                        output_bytes = output_bytes.saturating_add(size as u64);
                        if output_bytes > options.execution.stdout_limit {
                            failure.get_or_insert(Error::OutputTooLarge { stream: OutputStream::Stdout, limit: options.execution.stdout_limit });
                        } else if failure.is_none() {
                            pending_output = Some(StreamChunk { stream: OutputStream::Stdout, bytes: buffer[..size].to_vec() });
                        }
                    },
                    Err(error) if error.kind() == io::ErrorKind::BrokenPipe => output_done = true,
                    Err(error) => { output_done = true; failure.get_or_insert(Error::ProcessIo(error)); },
                }
            },
            written = async {
                let (bytes, offset) = pending_input.as_ref().expect("保留当前输入");
                pipes.input.write(&bytes[*offset..]).await
            }, if pending_input.is_some() && cleanup_deadline.is_none() => {
                match written {
                    Ok(0) => { failure.get_or_insert(Error::ProcessIo(io::Error::from(io::ErrorKind::WriteZero))); },
                    Ok(count) => {
                        let (bytes, offset) = pending_input.as_mut().expect("保留当前输入");
                        *offset += count;
                        if *offset == bytes.len() { pending_input.take(); }
                    },
                    Err(error) => { failure.get_or_insert(Error::ProcessIo(error)); },
                }
            },
            message = input.recv(), if cleanup_deadline.is_none() && pending_input.is_none() => {
                match message {
                    Some(Message::Bytes(bytes)) => {
                        if !bytes.is_empty() { pending_input = Some((bytes, 0)); }
                    },
                    Some(Message::Resize(size)) => { if let Err(error) = owner.resize(size) { failure.get_or_insert(error); } },
                    Some(Message::Eof) | None => { failure.get_or_insert(Error::Cancelled); },
                }
            },
            _ = poll.tick() => {},
        }
    }
}

async fn reap(
    mut owner: Owner,
    mut pipes: Pipes,
    mut console_close: Option<JoinHandle<()>>,
    mut console_closed: bool,
) {
    let mut output_done = false;
    let mut buffer = [0u8; 8192];
    let until = time::Instant::now() + Duration::from_secs(2);
    loop {
        let process_done = owner.unstarted() || matches!(owner.status(), Ok(Some(_)));
        let scope_done = owner.empty().unwrap_or(false);
        if process_done && scope_done && output_done && console_closed {
            owner.confirmed();
            return;
        }
        tokio::select! {
            _ = time::sleep_until(until) => return,
            result = async { console_close.as_mut().expect("回收PTY关闭工作").await }, if console_close.is_some() => {
                if result.is_err() { return; }
                console_close.take();
                console_closed = true;
            },
            result = pipes.output.read(&mut buffer), if !output_done => {
                match result {
                    Ok(0) => output_done = true,
                    Ok(_) => {},
                    Err(error) if error.kind() == io::ErrorKind::BrokenPipe => output_done = true,
                    Err(_) => return,
                }
            },
            _ = time::sleep(Duration::from_millis(25)) => {},
        }
    }
}
