use super::{FILE_LIMIT, Session, files};
use crate::{Error, Result, rules};
use apk_plugin_sdk::{ArtifactOutput, Request};
use deviceforge_plugin_runtime::Output;
use std::{
    fs::File,
    io::{Read, Write},
    path::PathBuf,
};

impl Session {
    pub(super) async fn publish(&self, request: &Request, source: PathBuf) -> Result<Output> {
        let root = PathBuf::from(
            request
                .artifacts
                .as_ref()
                .and_then(|artifacts| artifacts.output_directory.as_ref())
                .ok_or(Error::Invalid("未获截图输出授权"))?,
        );
        let target = root.join("screenshot.png");
        let lease = self.control.lease.clone();
        self.work(move |check| {
            check()?;
            files::regular(&root, true)?;
            let metadata = files::regular(&source, false)?;
            if metadata.len() > FILE_LIMIT {
                return Err(Error::TooLarge);
            }
            let mut input = File::open(&source).map_err(|_| Error::Io("私有截图无法打开"))?;
            files::opened(&source, &input, &metadata)?;
            let mut header = [0; 24];
            input
                .read_exact(&mut header)
                .map_err(|_| Error::Invalid("PNG头部不完整"))?;
            rules::artifacts::png(&header, metadata.len())?;
            check()?;
            let mut output = files::create(&target)?;
            *lease.output.lock().map_err(|_| Error::CleanupFailed)? = Some(target.clone());
            output
                .write_all(&header)
                .map_err(|_| Error::Io("授权截图无法写入"))?;
            let mut count = header.len() as u64;
            let mut buffer = [0; 64 * 1024];
            loop {
                check()?;
                let read = input
                    .read(&mut buffer)
                    .map_err(|_| Error::Io("私有截图无法读取"))?;
                if read == 0 {
                    break;
                }
                count = count
                    .checked_add(read as u64)
                    .filter(|count| *count <= metadata.len() && *count <= FILE_LIMIT)
                    .ok_or(Error::TooLarge)?;
                check()?;
                output
                    .write_all(&buffer[..read])
                    .map_err(|_| Error::Io("授权截图无法写入"))?;
            }
            if count != metadata.len() {
                return Err(Error::Invalid("截图长度在复制中改变"));
            }
            files::opened(&source, &input, &metadata)?;
            check()?;
            output.flush().map_err(|_| Error::Io("授权截图无法刷新"))?;
            drop(output);
            drop(input);
            let copied = files::regular(&target, false)?;
            if copied.len() != count {
                return Err(Error::Invalid("授权截图长度不一致"));
            }
            check()?;
            Ok(())
        })
        .await?;
        self.control.check()?;
        Ok(Output {
            value: serde_json::Value::Null,
            artifacts: vec![ArtifactOutput {
                filename: "screenshot.png".into(),
            }],
        })
    }
}
