//! 清单兼容安装器已有 inventory.json，每次复用和删除都重新核对全部普通文件。
use crate::{Error, Result, paths};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stamp {
    size: u64,
    sha256: String,
}
type Inventory = BTreeMap<String, Stamp>;

fn inventory(root: &Path, check: &dyn Fn() -> Result<()>) -> Result<Inventory> {
    let mut files = Inventory::new();
    let mut pending: Vec<PathBuf> = vec![root.to_owned()];
    let mut total = 0u64;
    let mut count = 0usize;
    while let Some(directory) = pending.pop() {
        check()?;
        paths::directory(&directory)?;
        for entry in fs::read_dir(directory)? {
            check()?;
            count += 1;
            if count > 32768 {
                return Err(Error::TooLarge);
            }
            let path = entry?.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| Error::Invalid("工具内容越界"))?
                .to_str()
                .ok_or(Error::Invalid("工具路径不是 UTF-8"))?
                .replace('\\', "/");
            if relative == "inventory.json" {
                continue;
            }
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.is_dir() {
                paths::directory(&path)?;
                pending.push(path);
            } else {
                let metadata = paths::file(&path)?;
                if metadata.len() > 2 * 1024 * 1024 * 1024 {
                    return Err(Error::TooLarge);
                }
                let mut source = fs::File::open(&path)?;
                let mut buffer = [0u8; 65536];
                let mut digest = Sha256::new();
                let mut size = 0u64;
                loop {
                    check()?;
                    let count = source.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    size = size
                        .checked_add(count as u64)
                        .filter(|size| *size <= metadata.len())
                        .ok_or(Error::TooLarge)?;
                    digest.update(&buffer[..count]);
                }
                if size != metadata.len() {
                    return Err(Error::Invalid("工具校验期间大小变化"));
                }
                total = total
                    .checked_add(size)
                    .filter(|size| *size <= 8 * 1024 * 1024 * 1024)
                    .ok_or(Error::TooLarge)?;
                files.insert(
                    relative,
                    Stamp {
                        size,
                        sha256: format!("{:x}", digest.finalize()),
                    },
                );
            }
        }
    }
    if files.is_empty() {
        return Err(Error::Invalid("工具内容不能为空"));
    }
    Ok(files)
}

pub(crate) fn seal(root: &Path, check: &dyn Fn() -> Result<()>) -> Result<()> {
    // 已有清单须验证后保留，不能重算覆盖从而掩盖暂存内容损坏。
    if root.join("inventory.json").exists() {
        return verify(root, check);
    }
    let files = inventory(root, check)?;
    check()?;
    paths::write(&root.join("inventory.json"), &files)
}
pub(crate) fn verify(root: &Path, check: &dyn Fn() -> Result<()>) -> Result<()> {
    let expected: Inventory = paths::read(&root.join("inventory.json"), 32 * 1024 * 1024)?;
    if expected != inventory(root, check)? {
        return Err(Error::Invalid("共享工具完整性校验失败"));
    }
    Ok(())
}
pub(crate) fn bytes(root: &Path, check: &dyn Fn() -> Result<()>) -> Result<u64> {
    inventory(root, check)?.values().try_fold(
        paths::file(&root.join("inventory.json"))?.len(),
        |total, stamp| total.checked_add(stamp.size).ok_or(Error::TooLarge),
    )
}
pub(crate) fn same(first: &Path, second: &Path, check: &dyn Fn() -> Result<()>) -> Result<()> {
    if inventory(first, check)? != inventory(second, check)? {
        return Err(Error::Invalid("同一归档摘要对应不同展开内容"));
    }
    Ok(())
}
