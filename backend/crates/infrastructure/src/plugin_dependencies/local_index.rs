//! 外部工具登记只保存已验证入口与内容身份，不接管文件和删除权。
use super::{discovery::Candidate, files, state::Selection};
use apk_domain::{Error, Result, plugin_dependencies::Dependency};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Read, path::Path, time::Instant};
use tokio_util::sync::CancellationToken;

#[derive(Serialize, Deserialize)]
struct LocalTool {
    format_version: u32,
    id: String,
    selection: Selection,
    contents: BTreeMap<String, String>,
}

fn contents(
    selection: &Selection,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<BTreeMap<String, String>> {
    let mut values = BTreeMap::new();
    for (id, path) in &selection.entries {
        let mut input = fs::File::open(files::file(path)?).map_err(files::io)?;
        let mut hash = Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            super::check(cancel, deadline)?;
            let count = input.read(&mut buffer).map_err(files::io)?;
            if count == 0 {
                break;
            }
            total = total
                .checked_add(count as u64)
                .filter(|total| *total <= 2 * 1024 * 1024 * 1024)
                .ok_or(Error::TooLarge)?;
            hash.update(&buffer[..count]);
        }
        values.insert(id.clone(), format!("{:x}", hash.finalize()));
    }
    Ok(values)
}

pub(super) fn register(
    root: &Path,
    id: &str,
    selection: &Selection,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<()> {
    if selection.key.is_some() {
        return Ok(());
    }
    let record = LocalTool {
        format_version: 1,
        id: id.into(),
        selection: selection.clone(),
        contents: contents(selection, cancel, deadline)?,
    };
    let identity =
        serde_json::to_vec(&record).map_err(|_| Error::Storage("本地工具身份编码失败".into()))?;
    let directory = root.join("plugin-dependencies/local-tools").join(id);
    let path = directory.join(format!("{:x}.json", Sha256::digest(identity)));
    if path.exists() {
        return Ok(());
    }
    if directory.exists()
        && fs::read_dir(&directory)
            .map_err(files::io)?
            .take(129)
            .count()
            >= 128
    {
        return Err(Error::Conflict(
            "同工具本地登记已达上限，请检查失效登记".into(),
        ));
    }
    files::write(&path, &record)
}

pub(super) fn candidates(
    root: &Path,
    dependency: &Dependency,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<Vec<Candidate>> {
    let directory = root
        .join("plugin-dependencies/local-tools")
        .join(&dependency.id);
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut candidates = Vec::new();
    for item in fs::read_dir(directory).map_err(files::io)?.take(128) {
        super::check(cancel, deadline)?;
        let item = item.map_err(files::io)?;
        if !item.file_type().map_err(files::io)?.is_file() {
            continue;
        }
        let Ok(record) = files::json::<LocalTool>(&item.path()) else {
            continue;
        };
        if record.format_version != 1
            || record.id != dependency.id
            || record.selection.key.is_some()
            || !dependency
                .entries
                .iter()
                .all(|id| record.selection.entries.contains_key(id))
        {
            continue;
        }
        match contents(&record.selection, cancel, deadline) {
            Ok(current) if current == record.contents => candidates.push(Candidate {
                selection: record.selection,
                lease: None,
                stage: None,
            }),
            Err(Error::Cancelled) => return Err(Error::Cancelled),
            Err(Error::Timeout) => return Err(Error::Timeout),
            _ => {}
        }
    }
    Ok(candidates)
}
