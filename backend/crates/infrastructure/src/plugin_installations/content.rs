//! 资源内容摘要与可复用目录清单，目录存在本身不构成完整性证据。
use super::paths;
use apk_domain::{Error, Result, plugin_installations::validate_release_path};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Read, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct FileStamp {
    pub size: u64,
    pub sha256: String,
}
pub(super) type Inventory = BTreeMap<String, FileStamp>;

pub(super) fn hash(path: &Path, limit: u64) -> Result<FileStamp> {
    hash_checked(path, limit, &|| Ok(()))
}
fn hash_checked(path: &Path, limit: u64, check: &dyn Fn() -> Result<()>) -> Result<FileStamp> {
    check()?;
    let metadata = paths::file(path)?;
    if metadata.len() > limit {
        return Err(Error::TooLarge);
    }
    let mut file = fs::File::open(path).map_err(|_| Error::Storage("资源校验读取失败".into()))?;
    let mut buffer = [0u8; 64 * 1024];
    let mut digest = Sha256::new();
    let mut size = 0u64;
    loop {
        check()?;
        let count = file
            .read(&mut buffer)
            .map_err(|_| Error::Storage("资源校验读取失败".into()))?;
        if count == 0 {
            break;
        }
        size = size
            .checked_add(count as u64)
            .filter(|size| *size <= limit)
            .ok_or(Error::TooLarge)?;
        digest.update(&buffer[..count]);
    }
    if size != metadata.len() {
        return Err(Error::Invalid("校验期间资源大小变化".into()));
    }
    Ok(FileStamp {
        size,
        sha256: format!("{:x}", digest.finalize()),
    })
}

pub(super) fn inventory(root: &Path) -> Result<Inventory> {
    inventory_checked(root, &|| Ok(()))
}
fn inventory_checked(root: &Path, check: &dyn Fn() -> Result<()>) -> Result<Inventory> {
    fn walk(
        root: &Path,
        current: &Path,
        files: &mut Inventory,
        total: &mut u64,
        check: &dyn Fn() -> Result<()>,
    ) -> Result<()> {
        check()?;
        paths::directory(current)?;
        for entry in fs::read_dir(current).map_err(|_| Error::Storage("资源目录校验失败".into()))?
        {
            check()?;
            let entry = entry.map_err(|_| Error::Storage("资源条目校验失败".into()))?;
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| Error::Invalid("资源目录越界".into()))?
                .to_string_lossy()
                .replace('\\', "/");
            if relative == "inventory.json" {
                continue;
            }
            validate_release_path(&relative)?;
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| Error::Storage("资源条目不可访问".into()))?;
            if metadata.is_dir() {
                walk(root, &path, files, total, check)?;
            } else {
                let stamp = hash_checked(
                    &path,
                    apk_domain::plugin_installations::RELEASE_RESOURCE_LIMIT,
                    check,
                )?;
                *total = total
                    .checked_add(stamp.size)
                    .filter(|size| *size <= 8 * 1024 * 1024 * 1024)
                    .ok_or(Error::TooLarge)?;
                files.insert(relative, stamp);
                if files.len() > 32768 {
                    return Err(Error::TooLarge);
                }
            }
        }
        Ok(())
    }
    let mut files = Inventory::new();
    walk(root, root, &mut files, &mut 0, check)?;
    Ok(files)
}

pub(super) fn verify(root: &Path) -> Result<()> {
    verify_checked(root, &|| Ok(()))
}
pub(super) fn verify_checked(root: &Path, check: &dyn Fn() -> Result<()>) -> Result<()> {
    check()?;
    let expected: Inventory = paths::read(&root.join("inventory.json"), 32 * 1024 * 1024)?;
    if expected != inventory_checked(root, check)? {
        return Err(Error::Invalid("已保存资源完整性校验失败".into()));
    }
    Ok(())
}

pub(super) fn seal(root: &Path) -> Result<()> {
    paths::write(&root.join("inventory.json"), &inventory(root)?)
}
