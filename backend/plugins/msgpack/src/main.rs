mod query;
#[cfg(test)]
mod tests;
use apk_plugin_sdk::{ARTIFACT_PROTOCOL_VERSION, ArtifactInput, ArtifactOutput, Request, Response};
use deviceforge_data_codec::{MAX_BYTES, decode_json, encode_json, json_bytes};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    path::Path,
};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Convert {
    artifact_id: String,
}
fn input<'a>(request: &'a Request, artifact_id: &str) -> Result<&'a ArtifactInput, String> {
    let context = request.artifacts.as_ref().ok_or("缺少宿主产物上下文")?;
    if context.inputs.len() != 1 {
        return Err("操作要求一个输入产物".into());
    }
    let input = &context.inputs[0];
    if input.field != "artifact_id" || input.artifact_id != artifact_id {
        return Err("输入产物与请求不一致".into());
    }
    if input.size > MAX_BYTES as u64 {
        return Err("输入产物超过 16 MiB".into());
    }
    Ok(input)
}
fn read(input: &ArtifactInput, extension: &str) -> Result<Vec<u8>, String> {
    if !input.filename.to_ascii_lowercase().ends_with(extension) {
        return Err("输入文件类型与操作不一致".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&input.path)
        .map_err(|_| "无法读取宿主输入副本")?
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "输入副本读取失败")?;
    if bytes.len() > MAX_BYTES || bytes.len() as u64 != input.size {
        return Err("输入大小与授权元数据不一致".into());
    }
    Ok(bytes)
}
fn execute(request: &Request) -> Result<(Value, Vec<ArtifactOutput>), String> {
    if request.protocol_version != ARTIFACT_PROTOCOL_VERSION {
        return Err("插件要求协议版本 2".into());
    }
    if request.operation == "query" {
        let options: query::Options = serde_json::from_value(request.input.clone())
            .map_err(|_| "查询参数无效或包含未知字段")?;
        options.validate()?;
        let input = input(request, &options.artifact_id)?;
        let value = decode_json(&read(input, ".msgpack")?).map_err(|e| e.to_string())?;
        return Ok((query::execute(value, options)?, Vec::new()));
    }
    if !matches!(request.operation.as_str(), "encode" | "decode") {
        return Err("未知操作".into());
    }
    let options: Convert =
        serde_json::from_value(request.input.clone()).map_err(|_| "转换参数只允许产物 ID")?;
    let input = input(request, &options.artifact_id)?;
    let (filename, bytes) = if request.operation == "encode" {
        (
            "converted.msgpack",
            encode_json(&read(input, ".json")?).map_err(|e| e.to_string())?,
        )
    } else {
        let value = decode_json(&read(input, ".msgpack")?).map_err(|e| e.to_string())?;
        (
            "converted.json",
            json_bytes(&value).map_err(|e| e.to_string())?,
        )
    };
    let directory = request
        .artifacts
        .as_ref()
        .and_then(|context| context.output_directory.as_ref())
        .ok_or("未获产物输出授权")?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(Path::new(directory).join(filename))
        .map_err(|_| "无法创建输出产物")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "输出产物写入失败")?;
    Ok((
        json!({"format_version":1,"source_artifact_id":input.artifact_id,"size":bytes.len(),"filename":filename}),
        vec![ArtifactOutput {
            filename: filename.into(),
        }],
    ))
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(512 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 512 * 1024 {
        return Err("请求超过 512 KiB".into());
    }
    if std::env::var_os("APK_API_TOKEN").is_some() {
        return Err("插件不应继承服务令牌".into());
    }
    let request: Request = serde_json::from_slice(&bytes)?;
    let (result, error, outputs) = match execute(&request) {
        Ok((value, outputs)) => (Some(value), None, outputs),
        Err(error) => (None, Some(error), Vec::new()),
    };
    let response = Response {
        protocol_version: request.protocol_version,
        request_id: request.request_id,
        result,
        error,
        outputs,
    };
    serde_json::to_writer(std::io::stdout().lock(), &response)?;
    println!();
    Ok(())
}
