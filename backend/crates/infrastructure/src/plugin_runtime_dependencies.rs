//! 脚本运行时只从当前依赖快照解析，包声明不携带本机程序路径。
use apk_domain::{Error, Result, plugin_dependencies::DependencyTargetKind};
use apk_plugin_sdk::{Manifest, packages::RuntimeDependency, resources::ManagedResources};
use serde::{Deserialize, Serialize};
use std::{fs, io::Read, path::Path};

pub(crate) const MARKER: &str = ".deviceforge-runtime.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Runtime {
    format_version: u32,
    dependency: RuntimeDependency,
}

pub(crate) fn write(directory: &Path, dependency: &RuntimeDependency) -> Result<()> {
    let bytes = serde_json::to_vec(&Runtime {
        format_version: 1,
        dependency: dependency.clone(),
    })
    .map_err(|_| Error::Invalid("脚本运行时描述编码失败".into()))?;
    fs::write(directory.join(MARKER), bytes)
        .map_err(|_| Error::Storage("脚本运行时描述写入失败".into()))
}

pub(crate) fn resolve(
    directory: &Path,
    user_root: Option<&Path>,
    manifest: &mut Manifest,
) -> Result<()> {
    let marker = directory.join(MARKER);
    if !marker.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(&marker)
        .map_err(|_| Error::Storage("脚本运行时描述不可访问".into()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 65_536 {
        return Err(Error::Invalid("脚本运行时描述必须是有界普通文件".into()));
    }
    let mut bytes = Vec::new();
    fs::File::open(marker)
        .and_then(|file| file.take(65_537).read_to_end(&mut bytes))
        .map_err(|_| Error::Storage("脚本运行时描述读取失败".into()))?;
    if bytes.len() > 65_536 {
        return Err(Error::TooLarge);
    }
    let runtime: Runtime =
        serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("脚本运行时描述无效".into()))?;
    if runtime.format_version != 1 {
        return Err(Error::Invalid("脚本运行时描述版本不支持".into()));
    }
    let root = user_root.ok_or_else(|| Error::Dependency("未装配共享依赖用户根".into()))?;
    let snapshot = crate::plugin_dependencies::snapshot_for(
        root,
        DependencyTargetKind::Server,
        &manifest.id,
        directory,
    )?
    .ok_or_else(|| Error::Dependency("脚本运行时尚未就绪，请检测或安装依赖".into()))?;
    let resources = ManagedResources::read(&snapshot)
        .map_err(|_| Error::Invalid("脚本运行时资源快照无效".into()))?;
    let entry = resources
        .entry(&runtime.dependency.id, &runtime.dependency.entry)
        .map_err(|_| Error::Dependency("脚本运行时入口尚未就绪".into()))?;
    if !entry.is_file() {
        return Err(Error::Dependency("脚本运行时入口已失效，请重新检测".into()));
    }
    manifest.executable = entry.to_string_lossy().into_owned();
    Ok(())
}
