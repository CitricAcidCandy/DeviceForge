//! 输入轨迹只使用授权产物和私有文件，正常录制通过 stdin exit 保存。
use crate::{
    Error, Result,
    config::Config,
    control::Control,
    files,
    input::{Playback, Record},
    msgpack,
};
use apk_plugin_sdk::{ArtifactOutput, Request};
use deviceforge_plugin_runtime::Output;
use serde_json::{Value, json};
use std::{
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

fn output_root(request: &Request) -> Result<PathBuf> {
    request
        .artifacts
        .as_ref()
        .and_then(|value| value.output_directory.as_ref())
        .map(PathBuf::from)
        .ok_or(Error::Invalid("未授权输入轨迹输出"))
}

async fn publish(
    control: &Control,
    request: &Request,
    result: Value,
    recording: Option<Vec<u8>>,
    operation: Value,
) -> Result<Output> {
    let root = output_root(request)?;
    let mut entries = vec![
        (
            "operation.json",
            serde_json::to_vec(&operation).map_err(|_| Error::Io("操作摘要无法编码"))?,
        ),
        (
            "input-trace.log",
            b"InputTrace\nexit=0\ncleanup=confirmed\n".to_vec(),
        ),
    ];
    if let Some(bytes) = recording {
        entries.insert(0, ("recording.msgpack", bytes));
    }
    let artifacts = entries
        .iter()
        .map(|(name, _)| ArtifactOutput {
            filename: (*name).into(),
        })
        .collect();
    control
        .work(move |context, resources| {
            files::regular(&root, true)?;
            for (name, data) in entries {
                context.check()?;
                let path = root.join(name);
                let mut file = files::create(&path)?;
                resources
                    .outputs
                    .lock()
                    .map_err(|_| Error::CleanupFailed)?
                    .push(path);
                for chunk in data.chunks(65536) {
                    context.check()?;
                    file.write_all(chunk)
                        .map_err(|_| Error::Io("产物无法写入"))?;
                }
                file.flush().map_err(|_| Error::Io("产物无法刷新"))?;
                context.check()?;
            }
            Ok(())
        })
        .await?;
    Ok(Output {
        value: result,
        artifacts,
    })
}

pub(crate) async fn record(
    control: &Control,
    request: &Request,
    config: &Config,
    input: Record,
) -> Result<Output> {
    let executable = config.trace()?;
    output_root(request)?;
    let directory = control.directory(config.scratch_root.clone()).await?;
    let path = directory.join("recording.msgpack");
    let args = vec![
        "record".into(),
        "-s".into(),
        "-f".into(),
        path.to_str()
            .ok_or(Error::Invalid("录制路径须为UTF-8"))?
            .into(),
        "-t".into(),
        input.event_type.to_string(),
        "-i".into(),
        input.interval_ms.to_string(),
    ];
    control
        .record_tool(
            executable,
            &args,
            &directory,
            Duration::from_millis(input.duration_ms),
        )
        .await?;
    let event_type = input.event_type;
    let (bytes, events) = control
        .work(move |context, _| {
            let bytes = files::read(&path, files::FILE_LIMIT, || {
                context.check().map_err(Into::into)
            })?;
            let (filtered, events) = msgpack::scan(&bytes, event_type)?;
            context.check()?;
            Ok((filtered, events))
        })
        .await?;
    publish(control, request, json!({"recorded":true,"event_type":input.event_type,"duration_ms":input.duration_ms,"events":events,"stop":"stdin_exit","format":"input_trace.msgpack.v1","effect_confirmed":false}), Some(bytes), json!({"operation":"record","event_type":input.event_type,"interval_ms":input.interval_ms,"duration_ms":input.duration_ms})).await
}

pub(crate) async fn playback(
    control: &Control,
    request: &Request,
    config: &Config,
    input: Playback,
) -> Result<Output> {
    let executable = config.trace()?;
    output_root(request)?;
    let artifact = request
        .artifacts
        .as_ref()
        .and_then(|access| {
            access.inputs.iter().find(|artifact| {
                artifact.field == "artifact_id" && artifact.artifact_id == input.artifact_id
            })
        })
        .cloned()
        .ok_or(Error::Invalid("回放产物未授权"))?;
    let directory = control.directory(config.scratch_root.clone()).await?;
    let path = directory.join("playback.msgpack");
    let private = path.clone();
    let event_type = input.event_type;
    let events = control
        .work(move |context, _| {
            let check = || context.check().map_err(Into::into);
            let bytes = files::read(Path::new(&artifact.path), files::FILE_LIMIT, check)?;
            files::verify(&bytes, artifact.size, &artifact.sha256)?;
            let (filtered, events) = msgpack::scan(&bytes, event_type)?;
            files::write(&private, &filtered, check)?;
            Ok(events)
        })
        .await?;
    let args = vec![
        "playback".into(),
        "-t".into(),
        input.event_type.to_string(),
        "-f".into(),
        path.to_str()
            .ok_or(Error::Invalid("回放路径须为UTF-8"))?
            .into(),
    ];
    control
        .capture(executable, &args, None, Some(&directory), false)
        .await?;
    control.check()?;
    publish(control, request, json!({"completed":true,"event_type":input.event_type,"events":events,"format":"input_trace.msgpack.v1","effect_confirmed":false}), None, json!({"operation":"playback","event_type":input.event_type,"artifact_id":input.artifact_id})).await
}
