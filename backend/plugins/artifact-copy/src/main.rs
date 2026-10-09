use apk_plugin_sdk::{ARTIFACT_PROTOCOL_VERSION, ArtifactOutput, Request, Response};
use std::{
    io::{Read, Write},
    path::Path,
};
fn execute(request: &Request) -> Result<(serde_json::Value, Vec<ArtifactOutput>), String> {
    if request.protocol_version != ARTIFACT_PROTOCOL_VERSION {
        return Err("插件要求协议版本 2".into());
    }
    if request.operation != "copy" {
        return Err("未知操作".into());
    }
    let context = request.artifacts.as_ref().ok_or("缺少宿主产物上下文")?;
    if context.inputs.len() != 1 {
        return Err("复制操作要求一个输入产物".into());
    }
    let input = &context.inputs[0];
    let output = context
        .output_directory
        .as_ref()
        .ok_or("未获产物输出授权")?;
    // 输出名称来自宿主验证过的显示文件名，只写入宿主提供的输出目录。
    std::fs::copy(&input.path, Path::new(output).join(&input.filename))
        .map_err(|e| e.to_string())?;
    Ok((
        serde_json::json!({"source_artifact_id":input.artifact_id,"size":input.size}),
        vec![ArtifactOutput {
            filename: input.filename.clone(),
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
    let request: Request = serde_json::from_slice(&bytes)?;
    if std::env::var_os("APK_API_TOKEN").is_some() {
        return Err("插件不应继承服务令牌".into());
    }
    let (result, error, outputs) = match execute(&request) {
        Ok((result, outputs)) => (Some(result), None, outputs),
        Err(error) => (None, Some(error), Vec::new()),
    };
    let response = Response {
        protocol_version: request.protocol_version,
        request_id: request.request_id,
        result,
        error,
        outputs,
    };
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &response)?;
    stdout.write_all(b"\n")?;
    Ok(())
}
