//! 安装元数据、同卷发布、部署删除及静态文件流。
use super::{FilePluginPackages, Prepared, Root, paths};
use apk_domain::{Error, Result, plugin_packages::*, plugins::plugin_id};
use std::{fs, io::Read, path::Path, sync::Arc};

const INFO: &str = ".deviceforge-package.json";

pub fn write_info(root: &Path, info: &PackageInfo) -> Result<()> {
    fs::write(
        root.join(INFO),
        serde_json::to_vec(info).map_err(|_| Error::Invalid("包视图序列化失败".into()))?,
    )
    .map_err(|_| Error::Storage("包视图写入失败".into()))
}
fn read_info(root: &Path, kind: PackageKind, id: &str) -> Result<PackageInfo> {
    let path = root.join(INFO);
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| Error::NotFound("在线安装包不存在".into()))?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || fs::canonicalize(&path).map_err(|_| Error::Storage("包视图不可访问".into()))? != path
    {
        return Err(Error::Invalid("包视图不得为链接".into()));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| Error::Storage("包视图读取失败".into()))?
        .take(65_537)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Storage("包视图读取失败".into()))?;
    if bytes.len() > 65_536 {
        return Err(Error::TooLarge);
    }
    let info: PackageInfo =
        serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("包视图无效".into()))?;
    if info.id != id || info.kind != kind {
        return Err(Error::Invalid("包视图与部署身份不一致".into()));
    }
    Ok(info)
}

pub fn commit(prepared: Prepared) -> Result<PackageInfo> {
    let _change = prepared
        .root
        .changes
        .lock()
        .map_err(|_| Error::Storage("包发布状态异常".into()))?;
    let destination = prepared.root.path.join(&prepared.info.id);
    if fs::symlink_metadata(&destination).is_ok() {
        return Err(Error::Conflict("同 ID 包已部署，不允许覆盖".into()));
    }
    // 只有本次生成的暂存内容进入发布，重命名位于相同部署根和卷。
    if list_without_lock(&prepared.root, prepared.info.kind)?.len() >= 256 {
        return Err(Error::Conflict("已安装包数量达到上限".into()));
    }
    crate::atomic_publish::retry("插件包保存", || {
        fs::rename(prepared.staging.path().join("content"), &destination)
    })
    .map_err(|_| Error::Storage("包原子发布失败".into()))?;
    Ok(prepared.info.clone())
}

pub fn replace(mut prepared: Prepared) -> Result<PackageInfo> {
    let _change = prepared
        .root
        .changes
        .lock()
        .map_err(|_| Error::Storage("包更新状态异常".into()))?;
    let destination = paths::existing(&prepared.root.path, &prepared.info.id, true)?;
    let previous = read_info(&destination, prepared.info.kind, &prepared.info.id)?;
    if previous.version == prepared.info.version {
        return Err(Error::Conflict("同版本包已部署，无需更新".into()));
    }
    // 旧部署先移到本次暂存目录；发布失败时在持锁期间恢复，绝不先删除。
    let backup = prepared.staging.path().join("previous");
    fs::rename(&destination, &backup)
        .map_err(|_| Error::Storage("旧包暂存失败，部署未更改".into()))?;
    if fs::rename(prepared.staging.path().join("content"), &destination).is_err() {
        if fs::rename(&backup, &destination).is_err() {
            // 恢复失败时保留唯一旧副本，禁止随暂存清理删除。
            if let Some(directory) = prepared.staging.directory.take() {
                let _ = directory.keep();
            }
            return Err(Error::Storage(
                "包更新及回滚失败，旧包保留于部署根的暂存目录".into(),
            ));
        }
        return Err(Error::Storage("新包发布失败，旧部署已恢复".into()));
    }
    Ok(prepared.info.clone())
}

pub fn list(root: &Root, kind: PackageKind) -> Result<Vec<PackageInfo>> {
    let _change = root
        .changes
        .lock()
        .map_err(|_| Error::Storage("包目录状态异常".into()))?;
    list_without_lock(root, kind)
}
fn list_without_lock(root: &Root, kind: PackageKind) -> Result<Vec<PackageInfo>> {
    let mut result = Vec::new();
    for (count, entry) in fs::read_dir(&root.path)
        .map_err(|_| Error::Storage("包目录读取失败".into()))?
        .enumerate()
    {
        if count >= 1024 {
            return Err(Error::TooLarge);
        }
        let entry = entry.map_err(|_| Error::Storage("包条目读取失败".into()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        plugin_id(&name)?;
        let directory = paths::existing(&root.path, &name, true)?;
        // 既有 CLI 部署没有在线安装视图，保持其部署独立，不猜测入口。
        if !directory.join(INFO).exists() {
            continue;
        }
        result.push(read_info(&directory, kind, &name)?);
        if result.len() > 256 {
            return Err(Error::TooLarge);
        }
    }
    result.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(result)
}

pub fn delete(root: &Root, kind: PackageKind, id: &str) -> Result<PackageInfo> {
    let _change = root
        .changes
        .lock()
        .map_err(|_| Error::Storage("包删除状态异常".into()))?;
    let directory = paths::existing(&root.path, id, true)?;
    let info = read_info(&directory, kind, id)?;
    // 校验后只移动已安装的指定包，失败不会碰到其他部署。
    let trash = tempfile::Builder::new()
        .prefix(".removed-")
        .tempdir_in(&root.path)
        .map_err(|_| Error::Storage("包删除暂存失败".into()))?;
    fs::rename(directory, trash.path().join("content"))
        .map_err(|_| Error::Storage("包删除发布失败".into()))?;
    trash
        .close()
        .map_err(|_| Error::Storage("包删除清理失败".into()))?;
    Ok(info)
}

fn media_type(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "html" => "text/html; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
pub async fn asset(store: &FilePluginPackages, id: &str, path: &str) -> Result<PackageAsset> {
    use futures_util::TryStreamExt;
    plugin_id(id)?;
    paths::relative(path)?;
    let permit = store
        .readers
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::Conflict("包资源读取并发已满".into()))?;
    let root: Arc<Root> = store.browser.clone();
    let id = id.to_owned();
    let relative = path.to_owned();
    let content_type = media_type(path).to_owned();
    let (file, size) = store
        .blocking(move || {
            let _change = root
                .changes
                .lock()
                .map_err(|_| Error::Storage("资源读取状态异常".into()))?;
            let directory = paths::existing(&root.path, &id, true)?;
            read_info(&directory, PackageKind::Browser, &id)?;
            let path = paths::existing(&directory, &relative, false)?;
            let file =
                fs::File::open(path).map_err(|_| Error::Storage("资源文件打开失败".into()))?;
            let size = file
                .metadata()
                .map_err(|_| Error::Storage("资源大小读取失败".into()))?
                .len();
            if size > 64 * 1024 * 1024 {
                return Err(Error::TooLarge);
            }
            Ok((file, size))
        })
        .await?;
    let stream =
        tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(file)).map_err(move |_| {
            let _ = &permit;
            Error::Storage("包资源传输失败".into())
        });
    Ok(PackageAsset {
        content_type,
        size,
        stream: Box::pin(stream),
    })
}
