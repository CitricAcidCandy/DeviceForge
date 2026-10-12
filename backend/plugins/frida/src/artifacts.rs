//! 输入授权、摘要副本及固定名称产物交付，不接受浏览器文件系统路径。
use crate::{Error, Result, control::Control, files, input::Operation};
use apk_plugin_sdk::{ArtifactOutput, Request};
use deviceforge_plugin_runtime::Output;
use serde_json::Value;
use std::{
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) fn validate(request: &Request, operation: &Operation) -> Result<()> {
    if request.protocol_version != 4 {
        return Err(Error::Invalid("Frida插件要求协议4"));
    }
    let artifacts = request
        .artifacts
        .as_ref()
        .ok_or(Error::Invalid("缺少产物授权封套"))?;
    let expected = match operation {
        Operation::Deploy(id) => Some(("/input/artifact_id", id.as_str())),
        Operation::Script(input) => Some((
            "/input/script_artifact_id",
            input.script_artifact_id.as_str(),
        )),
        _ => None,
    };
    match expected {
        Some((field, id))
            if artifacts.inputs.len() == 1
                && artifacts.inputs[0].field == field
                && artifacts.inputs[0].artifact_id == id =>
        {
            if artifacts.inputs[0].size == 0 || artifacts.inputs[0].size > files::FILE_LIMIT {
                return Err(Error::TooLarge);
            }
        }
        None if artifacts.inputs.is_empty() => (),
        _ => return Err(Error::Invalid("产物授权字段、标识或数量不一致")),
    }
    let root = artifacts
        .output_directory
        .as_ref()
        .ok_or(Error::Invalid("缺少输出目录授权"))?;
    files::absolute(Path::new(root))?;
    Ok(())
}
pub(crate) async fn prepare(
    control: &Control,
    request: &Request,
    root: &Path,
    filename: &'static str,
) -> Result<PathBuf> {
    let artifact = request
        .artifacts
        .as_ref()
        .and_then(|a| a.inputs.first())
        .ok_or(Error::Invalid("缺少输入产物"))?
        .clone();
    let destination = root.join(filename);
    let target = destination.clone();
    control
        .work(move |context, _| {
            let data = files::read(Path::new(&artifact.path), files::FILE_LIMIT, || {
                context.check().map_err(Into::into)
            })?;
            files::verify(&data, artifact.size, &artifact.sha256)?;
            if filename == "script.js" && (data.contains(&0) || std::str::from_utf8(&data).is_err())
            {
                return Err(Error::Invalid("脚本必须为不含空字节的UTF-8"));
            }
            files::write(&target, &data, || context.check().map_err(Into::into))?;
            Ok(())
        })
        .await?;
    Ok(destination)
}
pub(crate) async fn publish(
    control: &Control,
    request: &Request,
    value: Value,
    log: Vec<u8>,
    extra: Vec<(&'static str, Vec<u8>)>,
) -> Result<Output> {
    let root = PathBuf::from(
        request
            .artifacts
            .as_ref()
            .and_then(|a| a.output_directory.as_ref())
            .ok_or(Error::Invalid("缺少输出授权"))?,
    );
    let serialized =
        serde_json::to_vec_pretty(&value).map_err(|_| Error::Invalid("结果无法序列化"))?;
    let mut items = vec![("operation.json", serialized), ("frida.log", log)];
    items.extend(extra);
    let names: Vec<String> = items.iter().map(|(name, _)| (*name).into()).collect();
    control
        .work(move |context, resources| {
            files::regular(&root, true)?;
            for (name, data) in items {
                context.check()?;
                if data.len() as u64 > files::FILE_LIMIT {
                    return Err(Error::TooLarge);
                }
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
    control.check()?;
    Ok(Output {
        value,
        artifacts: names
            .into_iter()
            .map(|filename| ArtifactOutput { filename })
            .collect(),
    })
}
