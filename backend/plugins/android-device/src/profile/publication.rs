//! 固定Stored归档与授权双文件发布；失败撤销只操作本任务创建的路径。
use super::{models::Index, report::Report};
use crate::{
    Error, Result,
    session::{FILE_LIMIT, Session, files},
};
use apk_plugin_sdk::{ArtifactOutput, Request};
use deviceforge_plugin_runtime::Output;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

pub(crate) fn prepare(
    root: &Path,
    index: &Index,
    report: &Report,
    raw: bool,
    check: &(dyn Fn() -> Result<()> + Sync),
) -> Result<()> {
    check()?;
    let index_bytes =
        serde_json::to_vec(index).map_err(|_| Error::Dependency("录制索引无法编码"))?;
    if index_bytes.len() > 1024 * 1024 {
        return Err(Error::TooLarge);
    }
    let mut file = files::create(&root.join("profile-index.json"))?;
    file.write_all(&index_bytes)
        .map_err(|_| Error::Io("录制索引无法写入"))?;
    file.flush().map_err(|_| Error::Io("录制索引无法刷新"))?;
    drop(file);
    let mut stacks = files::create(&root.join("stacks.jsonl"))?;
    let mut total = 0usize;
    for sample in &report.samples {
        check()?;
        let bytes =
            serde_json::to_vec(sample).map_err(|_| Error::Dependency("调用栈行无法编码"))?;
        total = total
            .checked_add(bytes.len() + 1)
            .filter(|x| *x <= 32 * 1024 * 1024)
            .ok_or(Error::TooLarge)?;
        stacks
            .write_all(&bytes)
            .and_then(|_| stacks.write_all(b"\n"))
            .map_err(|_| Error::Io("调用栈文件无法写入"))?;
    }
    stacks
        .flush()
        .map_err(|_| Error::Io("调用栈文件无法刷新"))?;
    drop(stacks);
    let archive = files::create(&root.join("profile.zip"))?;
    let mut writer = ZipWriter::new(archive);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(false);
    let mut names = vec!["profile-index.json".to_owned(), "stacks.jsonl".to_owned()];
    if raw {
        names.push("perf.bin".into());
    }
    for sample in &index.samples {
        if let Some(frame) = &sample.frame {
            let expected = format!("frames/{:06}.png", sample.index);
            if frame.index != sample.index || frame.filename != expected || sample.index >= 16 {
                return Err(Error::Invalid("录制画面文件名或索引无效"));
            }
            names.push(frame.filename.clone());
        }
    }
    let mut count = 0u64;
    for name in names {
        check()?;
        let path = root.join(&name);
        let metadata = files::regular(&path, false)?;
        count = count
            .checked_add(metadata.len())
            .filter(|x| *x < FILE_LIMIT.saturating_sub(65536))
            .ok_or(Error::TooLarge)?;
        let mut input = File::open(&path).map_err(|_| Error::Io("录制归档输入无法打开"))?;
        files::opened(&path, &input, &metadata)?;
        if name.ends_with(".png") {
            let mut header = [0; 24];
            input
                .read_exact(&mut header)
                .map_err(|_| Error::Invalid("采样画面PNG不完整"))?;
            crate::rules::artifacts::png(&header, metadata.len())?;
            input
                .seek(SeekFrom::Start(0))
                .map_err(|_| Error::Io("采样画面无法复位"))?;
        }
        writer
            .start_file(name, options)
            .map_err(|_| Error::Io("录制ZIP条目无法创建"))?;
        copy(&mut input, &mut writer, metadata.len(), check)?;
        files::opened(&path, &input, &metadata)?;
    }
    let mut archive = writer.finish().map_err(|_| Error::Io("录制ZIP无法收口"))?;
    archive.flush().map_err(|_| Error::Io("录制ZIP无法刷新"))?;
    if archive
        .metadata()
        .map_err(|_| Error::Io("录制ZIP无法读取长度"))?
        .len()
        > FILE_LIMIT
    {
        return Err(Error::TooLarge);
    }
    check()
}
fn copy(
    input: &mut File,
    output: &mut impl Write,
    length: u64,
    check: &(dyn Fn() -> Result<()> + Sync),
) -> Result<()> {
    let mut buffer = [0; 64 * 1024];
    let mut count = 0u64;
    loop {
        check()?;
        let read = input
            .read(&mut buffer)
            .map_err(|_| Error::Io("录制产物无法读取"))?;
        if read == 0 {
            break;
        }
        count = count
            .checked_add(read as u64)
            .filter(|x| *x <= length && *x <= FILE_LIMIT)
            .ok_or(Error::TooLarge)?;
        output
            .write_all(&buffer[..read])
            .map_err(|_| Error::Io("录制产物无法写入"))?;
    }
    if count != length {
        return Err(Error::Invalid("录制产物长度在复制中变化"));
    }
    check()
}
impl Session {
    pub(crate) async fn publish_profile(
        &self,
        request: &Request,
        source: PathBuf,
        value: serde_json::Value,
    ) -> Result<Output> {
        let root = PathBuf::from(
            request
                .artifacts
                .as_ref()
                .and_then(|a| a.output_directory.as_ref())
                .ok_or(Error::Invalid("未获录制输出授权"))?,
        );
        let lease = self.control.lease.clone();
        self.work(move |check| {
            files::regular(&root, true)?;
            for name in ["profile-index.json", "profile.zip"] {
                check()?;
                let path = source.join(name);
                let metadata = files::regular(&path, false)?;
                if metadata.len() > FILE_LIMIT {
                    return Err(Error::TooLarge);
                }
                let mut input = File::open(&path).map_err(|_| Error::Io("私有录制产物无法打开"))?;
                files::opened(&path, &input, &metadata)?;
                let target = root.join(name);
                let mut output = files::create(&target)?;
                lease
                    .profile_outputs
                    .lock()
                    .map_err(|_| Error::CleanupFailed)?
                    .push(target.clone());
                copy(&mut input, &mut output, metadata.len(), check)?;
                output
                    .flush()
                    .map_err(|_| Error::Io("授权录制产物无法刷新"))?;
                drop(output);
                if files::regular(&target, false)?.len() != metadata.len() {
                    return Err(Error::Invalid("授权录制产物长度不一致"));
                }
                files::opened(&path, &input, &metadata)?;
            }
            check()
        })
        .await?;
        self.control.check()?;
        Ok(Output {
            value,
            artifacts: vec![
                ArtifactOutput {
                    filename: "profile-index.json".into(),
                },
                ArtifactOutput {
                    filename: "profile.zip".into(),
                },
            ],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn no_root_archive_is_stored_has_empty_stacks_and_no_trace_or_descriptor() {
        let root = tempfile::tempdir().unwrap();
        let index = Index {
            format_version: 1,
            device_id: "serial".into(),
            package: "com.example.game".into(),
            pid: 1,
            process_start_ticks: "1".into(),
            clock: "boottime",
            frame_kind: "scrcpy_sampled_frame",
            display_frame_complete: false,
            samples: Vec::new(),
            stack_sample_count: 0,
            reported_sample_count: "0".into(),
            lost_count: "0".into(),
            stack_status: "unavailable",
            stack_reason: Some("无Root"),
            root_access: "none",
            frame_status: "disabled",
            frame_reason: None,
            symbolication: "reported_symbols_only",
        };
        let report = Report {
            samples: Vec::new(),
            lost_count: 0,
            reported_sample_count: 0,
            events: Vec::new(),
        };
        prepare(root.path(), &index, &report, false, &|| Ok(())).unwrap();
        let bytes = std::fs::read(root.path().join("profile.zip")).unwrap();
        assert_eq!(&bytes[..4], b"PK\x03\x04");
        assert_eq!(u16::from_le_bytes([bytes[6], bytes[7]]) & 8, 0);
        let mut archive =
            zip::ZipArchive::new(File::open(root.path().join("profile.zip")).unwrap()).unwrap();
        assert_eq!(archive.len(), 2);
        assert!(archive.by_name("perf.bin").is_err());
        let stacks = archive.by_name("stacks.jsonl").unwrap();
        assert_eq!(stacks.size(), 0);
        assert_eq!(stacks.compression(), CompressionMethod::Stored);
    }
}
