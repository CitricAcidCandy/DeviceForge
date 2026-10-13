mod jpeg;
mod models;
mod publish;
mod receive;
mod rules;
mod scripts;

use crate::{Control, Error, Result, config::Config, control::RemotePhase, session::files};
use apk_plugin_sdk::{ArtifactOutput, Request};
use deviceforge_plugin_runtime::{Execution, Output};
use std::{
    fs::File,
    io::{Seek, SeekFrom, Write},
    path::PathBuf,
    sync::atomic::Ordering,
};

pub(crate) fn validate_context(request: &Request) -> Result<PathBuf> {
    let artifacts = request
        .artifacts
        .as_ref()
        .ok_or(Error::Invalid("未获截图输出授权"))?;
    if !artifacts.inputs.is_empty() {
        return Err(Error::Invalid("截图不接受输入产物"));
    }
    let root = artifacts
        .output_directory
        .as_ref()
        .ok_or(Error::Invalid("未获截图输出授权"))?;
    Ok(PathBuf::from(root).join("screenshot.jpeg"))
}

pub(crate) async fn execute(
    control: Control,
    config: Config,
    request: &Request,
    device: String,
) -> Execution {
    let screenshot = Screenshot { control, device };
    let result = screenshot.run(config, request).await;
    let result = screenshot
        .control
        .context
        .check()
        .map_err(Error::from)
        .and(result);
    let result = if result.is_err() {
        let remote = screenshot.clear(true).await;
        let local = publish::cleanup(&screenshot.control, true).await;
        if remote.is_err() || local.is_err() {
            screenshot.control.unresolved.store(true, Ordering::Release);
            Err(Error::CleanupFailed)
        } else {
            result
        }
    } else {
        result
    };
    screenshot.control.finish_output(result)
}

struct Screenshot {
    control: Control,
    device: String,
}

impl Screenshot {
    async fn run(&self, config: Config, request: &Request) -> Result<Output> {
        let target = validate_context(request)?;
        let (directory, token) = publish::prepare(
            &self.control,
            config.scratch_root.unwrap_or_else(std::env::temp_dir),
            target,
        )
        .await?;
        self.probe(&token).await?;
        self.capture(&token).await?;
        let size = self.size(&token).await?;
        let frame_path = directory.join("screenshot.b64");
        let captured = self
            .control
            .capture_file(
                scripts::args(&self.device, scripts::READ, &token)?,
                frame_path.clone(),
                models::FRAME_LIMIT,
            )
            .await?;
        let frame_token = token.clone();
        let frame_source = frame_path.clone();
        let frame = self
            .control
            .work(move |check| {
                check()?;
                receive::frame(&frame_source, &frame_token, captured.bytes)
            })
            .await?;
        self.control.lease.phase(RemotePhase::Read)?;
        let image = directory.join("screenshot.jpeg");
        let decoded = image.clone();
        self.control
            .work(move |check| {
                check()?;
                let metadata = files::regular(&frame_path, false)?;
                let mut input = File::open(&frame_path).map_err(|_| Error::Io("编码帧无法打开"))?;
                files::opened(&frame_path, &input, &metadata)?;
                crate::rules::text(b"", &captured.stderr)?;
                receive::diagnostics(&mut input, frame.body_bytes, check)?;
                if frame.status != 0 {
                    return Err(Error::Dependency("设备Base64回传执行失败"));
                }
                input
                    .seek(SeekFrom::Start(0))
                    .map_err(|_| Error::Io("编码正文无法定位"))?;
                let mut output = files::create(&decoded)?;
                let result =
                    receive::decode(&mut input, &mut output, frame.body_bytes, size, check);
                let flushed = output.flush().map_err(|_| Error::CleanupFailed);
                drop(output);
                drop(input);
                flushed?;
                result?;
                check()?;
                Ok(())
            })
            .await?;
        publish::copy(&self.control, image).await?;
        self.clear(false).await?;
        publish::cleanup(&self.control, false).await?;
        self.control.check()?;
        Ok(Output {
            value: serde_json::Value::Null,
            artifacts: vec![ArtifactOutput {
                filename: "screenshot.jpeg".into(),
            }],
        })
    }

    async fn probe(&self, token: &str) -> Result<()> {
        self.control.lease.phase(RemotePhase::ProbePending)?;
        let captured = self
            .control
            .capture(&scripts::args(&self.device, scripts::PROBE, token)?)
            .await?;
        let text = rules::utf8(&captured.stdout)?;
        let status = rules::status(rules::terminal(text, "DF_PROBE_DONE", token)?)?;
        self.control.lease.phase(RemotePhase::Idle)?;
        crate::rules::text(&captured.stdout, &captured.stderr)?;
        if status != 0 {
            return Err(Error::Dependency("设备未通过base64 -w 0资格探测"));
        }
        rules::probe(text, token, &captured.stderr)
    }

    async fn capture(&self, token: &str) -> Result<()> {
        self.control.lease.phase(RemotePhase::CapturePending)?;
        let captured = self
            .control
            .capture(&scripts::args(&self.device, scripts::CAPTURE, token)?)
            .await?;
        let text = rules::utf8(&captured.stdout)?;
        if rules::exact(text, "DF_DIR_REJECTED", token) {
            self.control.lease.phase(RemotePhase::Rejected)?;
            crate::rules::text(&captured.stdout, &captured.stderr)?;
            return Err(Error::Dependency("设备截图独占目录创建失败"));
        }
        let status = rules::status(rules::terminal(text, "DF_CAPTURED", token)?)?;
        self.control.lease.phase(RemotePhase::Captured)?;
        rules::captured(text, token, &captured.stderr, status)
    }

    async fn size(&self, token: &str) -> Result<u64> {
        self.control.lease.phase(RemotePhase::SizePending)?;
        let captured = self
            .control
            .capture(&scripts::args(&self.device, scripts::SIZE, token)?)
            .await?;
        let text = rules::utf8(&captured.stdout)?;
        if rules::exact(text, "DF_SIZE_REJECTED", token) {
            self.control.lease.phase(RemotePhase::Captured)?;
            crate::rules::text(&captured.stdout, &captured.stderr)?;
            return Err(Error::Dependency("设备截图文件资格查询失败"));
        }
        let result = rules::terminal(text, "DF_IMAGE_SIZE", token)?;
        let (status, size) = result
            .split_once(':')
            .ok_or(Error::Dependency("设备截图大小回执无效"))?;
        let status = rules::status(status)?;
        self.control.lease.phase(RemotePhase::Sized)?;
        crate::rules::text(&captured.stdout, &captured.stderr)?;
        if text
            .lines()
            .any(|line| !line.trim().is_empty() && !line.starts_with("DF_IMAGE_SIZE:"))
        {
            return Err(Error::Dependency("设备截图大小回执无效"));
        }
        if status != 0 {
            return Err(Error::Dependency("设备截图文件大小查询失败"));
        }
        rules::size(size)
    }

    async fn clear(&self, failed: bool) -> Result<()> {
        let Some((token, phase)) = self.control.lease.remote()? else {
            return Ok(());
        };
        match phase {
            RemotePhase::Idle | RemotePhase::Rejected | RemotePhase::Cleared => return Ok(()),
            RemotePhase::Captured | RemotePhase::Sized | RemotePhase::Read => {}
            _ => return Err(Error::CleanupFailed),
        }
        self.control.lease.phase(RemotePhase::ClearPending)?;
        let args = scripts::args(&self.device, scripts::CLEAR, &token)?;
        let captured = if failed {
            self.control.capture_cleanup(&args).await?
        } else {
            self.control.capture(&args).await?
        };
        let text = rules::utf8(&captured.stdout)?;
        if !rules::exact(text, "DF_CLEARED", &token) {
            return Err(Error::CleanupFailed);
        }
        crate::rules::text(&captured.stdout, &captured.stderr)?;
        self.control.lease.phase(RemotePhase::Cleared)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
