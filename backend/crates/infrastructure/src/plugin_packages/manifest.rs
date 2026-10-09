//! 便携清单映射和公开进程插件门禁，不执行入口。
use super::paths;
use crate::plugins::ProcessPlugin;
use apk_domain::{Error, Executor, Operation, Result, now, plugin_packages::*, plugins::plugin_id};
use apk_plugin_sdk::{Manifest, packages::*};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn node_binary(configured: Option<PathBuf>) -> Result<Option<PathBuf>> {
    if let Some(path) = configured {
        if !path.is_absolute() || !path.is_file() {
            return Err(Error::Invalid(
                "管理员 Node 入口必须为存在的绝对文件".into(),
            ));
        }
        return fs::canonicalize(path)
            .map(Some)
            .map_err(|_| Error::Storage("Node 程序不可访问".into()));
    }
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    Ok(std::env::var_os("PATH")
        .and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|directory| directory.join(name))
                .find(|path| path.is_file())
        })
        .and_then(|path| fs::canonicalize(path).ok()))
}

fn platform() -> String {
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    };
    format!("{os}-{arch}")
}

fn node_script_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    // Node 在 Windows 的模块解析不接受 Rust canonicalize 的扩展长度前缀。
    #[cfg(windows)]
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    #[cfg(windows)]
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return rest.to_owned();
    }
    value.into_owned()
}

pub fn validate(
    root: &Path,
    destination_root: &Path,
    kind: PackageKind,
    node: Option<&Path>,
) -> Result<(PackageInfo, Vec<Operation>)> {
    let package: PortablePackage = paths::json(root, "package.json")?;
    if package.version.trim().is_empty() || package.version.len() > 100 {
        return Err(Error::Invalid("包版本无效".into()));
    }
    let expected = match kind {
        PackageKind::Server => "server",
        PackageKind::Browser => "browser",
    };
    if package.deviceforge.kind != expected {
        return Err(Error::Invalid("上传种类与便携包声明不一致".into()));
    }
    let entry = if kind == PackageKind::Browser {
        package.deviceforge.entrypoints.get("any")
    } else {
        package
            .deviceforge
            .entrypoints
            .get(&platform())
            .or_else(|| package.deviceforge.entrypoints.get("any"))
    }
    .ok_or_else(|| Error::Invalid("包不支持当前宿主平台".into()))?;
    let entry_file = paths::existing(root, &entry.path, false)?;
    let (id, version, api_version, operations) = match kind {
        PackageKind::Browser => {
            let manifest: BrowserManifest = paths::json(root, &package.deviceforge.manifest)?;
            if manifest.api_version != 2
                || entry.runtime != "browser"
                || !(entry.path.ends_with(".js") || entry.path.ends_with(".mjs"))
                || !manifest
                    .id
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_lowercase)
            {
                return Err(Error::Invalid(
                    "浏览器包要求 SDK API 2 和 ES 模块入口".into(),
                ));
            }
            (
                manifest.id,
                manifest.version,
                Some(manifest.api_version),
                vec![],
            )
        }
        PackageKind::Server => {
            if entry.path.eq_ignore_ascii_case("manifest.json") {
                return Err(Error::Invalid(
                    "服务器程序入口不得占用生成清单 manifest.json".into(),
                ));
            }
            let portable: PortableServerManifest =
                paths::json(root, &package.deviceforge.manifest)?;
            if portable.operations.len() > 4096
                || portable.args.len() > 128
                || portable
                    .args
                    .iter()
                    .any(|arg| arg.len() > 4096 || arg.contains('\0'))
            {
                return Err(Error::TooLarge);
            }
            if !["native", "node"].contains(&entry.runtime.as_str()) {
                return Err(Error::Invalid("服务器入口只接受 native/node".into()));
            }
            let executable = if entry.runtime == "node" {
                node.ok_or_else(|| Error::Dependency("宿主未配置可用 Node 程序".into()))?
                    .to_path_buf()
            } else {
                entry_file.clone()
            };
            let mut args = portable.args.clone();
            if entry.runtime == "node" {
                args.insert(0, node_script_path(&entry_file));
            }
            let mut manifest = Manifest {
                id: portable.id.clone(),
                version: portable.version.clone(),
                protocol_version: portable.protocol_version,
                executable: executable.to_string_lossy().into_owned(),
                args,
                operations: portable.operations,
                artifacts: portable.artifacts,
                performance: portable.performance,
                devices: portable.devices,
            };
            let plugin = ProcessPlugin::new(manifest.clone()).map_err(|error| match error {
                Error::Conflict(_) => Error::Invalid("包清单包含无效或重复贡献".into()),
                other => other,
            })?;
            let operations = plugin.operations();
            // 检查暂存入口存在后才映射最终机器路径，生成 FilePluginCatalog 使用的清单。
            let final_entry = destination_root
                .join(&portable.id)
                .join(paths::relative(&entry.path)?);
            if entry.runtime == "native" {
                manifest.executable = final_entry.to_string_lossy().into_owned();
            } else {
                manifest.args[0] = node_script_path(&final_entry);
            }
            let bytes = serde_json::to_vec(&manifest)
                .map_err(|_| Error::Invalid("清单无法序列化".into()))?;
            if bytes.len() > 65_536 {
                return Err(Error::TooLarge);
            }
            fs::write(root.join("manifest.json"), bytes)
                .map_err(|_| Error::Storage("运行清单写入失败".into()))?;
            (portable.id, portable.version, None, operations)
        }
    };
    plugin_id(&id)?;
    if version != package.version {
        return Err(Error::Invalid("便携包与插件清单版本不一致".into()));
    }
    let entry_url = (kind == PackageKind::Browser).then(|| {
        let encoded: String = entry
            .path
            .bytes()
            .map(|byte| {
                if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
                    (byte as char).to_string()
                } else {
                    format!("%{byte:02X}")
                }
            })
            .collect();
        format!("/api/v2/browser-plugins/{id}/assets/{encoded}")
    });
    Ok((
        PackageInfo {
            kind,
            id,
            version,
            runtime: entry.runtime.clone(),
            entry_path: entry.path.clone(),
            entry_url,
            api_version,
            installed_at: now(),
        },
        operations,
    ))
}
