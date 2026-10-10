use super::{FILE_LIMIT, Session, files};
use crate::{Error, Result};
use apk_plugin_sdk::Request;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(super) struct Prepared {
    pub path: PathBuf,
    pub filename: String,
}

impl Session {
    pub(super) async fn prepare_input(
        &self,
        request: &Request,
        artifact_id: &str,
        root: &Path,
    ) -> Result<Prepared> {
        let artifact = request
            .artifacts
            .as_ref()
            .and_then(|artifacts| artifacts.inputs.first())
            .ok_or(Error::Invalid("缺少安装输入授权"))?
            .clone();
        if artifact.field != "/input/artifact_id" || artifact.artifact_id != artifact_id {
            return Err(Error::Invalid("安装输入产物关联不一致"));
        }
        let source = PathBuf::from(&artifact.path);
        let destination = root.join("input.hap");
        let target = destination.clone();
        self.work(move |check| {
            check()?;
            let metadata = files::regular(&source, false)?;
            if metadata.len() != artifact.size {
                return Err(Error::Invalid("输入产物长度不一致"));
            }
            let mut input = File::open(&source).map_err(|_| Error::Io("输入产物无法打开"))?;
            files::opened(&source, &input, &metadata)?;
            check()?;
            let mut output = files::create(&target)?;
            let mut hash = Sha256::new();
            let mut count = 0u64;
            let mut buffer = [0; 64 * 1024];
            loop {
                check()?;
                let read = input
                    .read(&mut buffer)
                    .map_err(|_| Error::Io("输入产物无法读取"))?;
                if read == 0 {
                    break;
                }
                count = count
                    .checked_add(read as u64)
                    .filter(|count| *count <= artifact.size && *count <= FILE_LIMIT)
                    .ok_or(Error::TooLarge)?;
                hash.update(&buffer[..read]);
                check()?;
                output
                    .write_all(&buffer[..read])
                    .map_err(|_| Error::Io("私有安装副本无法写入"))?;
            }
            if count != artifact.size
                || !format!("{:x}", hash.finalize()).eq_ignore_ascii_case(&artifact.sha256)
            {
                return Err(Error::Invalid("输入产物大小或SHA256不一致"));
            }
            files::opened(&source, &input, &metadata)?;
            check()?;
            output
                .flush()
                .map_err(|_| Error::Io("私有安装副本无法刷新"))?;
            drop(output);
            drop(input);
            check()?;
            if files::regular(&target, false)?.len() != count {
                return Err(Error::Invalid("私有安装副本长度不一致"));
            }
            Ok(artifact.filename)
        })
        .await
        .map(|filename| Prepared {
            path: destination,
            filename,
        })
    }
}
