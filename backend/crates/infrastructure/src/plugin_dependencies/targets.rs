//! 发布拥有的组件归并为同一依赖目标，独立组件读取根目录旁置声明。
use super::{FilePluginDependencies, files};
use apk_domain::{
    Error, Result, plugin_dependencies::*, plugin_installations::InstalledRelease,
    plugin_packages::PackageKind, plugins::plugin_id,
};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub(super) struct Component {
    pub kind: DependencyTargetKind,
    pub id: String,
    pub deployment_digest: String,
    pub runtime: Option<RuntimeDependency>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RuntimeDependency {
    pub id: String,
    pub entry: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeMetadata {
    format_version: u32,
    dependency: RuntimeDependency,
}

#[derive(Clone)]
pub(super) struct ResolvedTarget {
    pub target: DependencyTarget,
    pub revision: String,
    pub manifest: DependencyManifest,
    pub components: Vec<Component>,
    pub publication_identity: Option<String>,
}

pub(super) fn releases_at(root: &Path) -> Result<Vec<InstalledRelease>> {
    let directory = root.join("installations/releases");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut records: Vec<InstalledRelease> = Vec::new();
    for (count, entry) in fs::read_dir(directory).map_err(files::io)?.enumerate() {
        if count >= 512 {
            return Err(Error::TooLarge);
        }
        let entry = entry.map_err(files::io)?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            return Err(Error::Invalid("发布记录文件名无效".into()));
        }
        let record: InstalledRelease = files::json(&entry.path())?;
        plugin_id(&record.id)?;
        if entry.path().file_stem().and_then(|value| value.to_str()) != Some(record.id.as_str()) {
            return Err(Error::Invalid("发布记录身份不匹配".into()));
        }
        apk_domain::plugin_installations::validate_release_digest(&record.revision)?;
        for component in &record.components {
            plugin_id(&component.id)?;
        }
        records.push(record);
    }
    Ok(records)
}

fn component_kind(kind: PackageKind) -> DependencyTargetKind {
    if kind == PackageKind::Server {
        DependencyTargetKind::Server
    } else {
        DependencyTargetKind::Browser
    }
}

pub(super) fn component_root(
    store: &FilePluginDependencies,
    kind: DependencyTargetKind,
    id: &str,
) -> Result<PathBuf> {
    let roots = if kind == DependencyTargetKind::Browser {
        &store.browser_roots
    } else {
        &store.server_roots
    };
    let candidates: Vec<_> = roots
        .iter()
        .map(|root| root.join(id))
        .filter(|directory| directory.is_dir())
        .collect();
    if candidates.len() > 1 {
        return Err(Error::Conflict(
            "组件在多个部署根中重复，无法确定依赖声明".into(),
        ));
    }
    candidates
        .into_iter()
        .next()
        .ok_or_else(|| Error::NotFound("依赖组件尚未部署".into()))
}

fn merge(
    target: &mut DependencyManifest,
    mut manifest: DependencyManifest,
    component: Option<&str>,
) -> Result<()> {
    for dependency in &mut manifest.dependencies {
        for binding in &mut dependency.bindings {
            if binding.component_id.is_empty() {
                binding.component_id = component
                    .ok_or_else(|| Error::Invalid("完整发布依赖绑定缺少组件标识".into()))?
                    .into();
            }
        }
    }
    for dependency in manifest.dependencies {
        if let Some(existing) = target
            .dependencies
            .iter_mut()
            .find(|value| value.id == dependency.id)
        {
            let mut left = existing.clone();
            let mut right = dependency.clone();
            left.bindings.clear();
            right.bindings.clear();
            if component.is_none()
                && serde_json::to_value(left)
                    .map_err(|_| Error::Storage("依赖声明编码失败".into()))?
                    != serde_json::to_value(right)
                        .map_err(|_| Error::Storage("依赖声明编码失败".into()))?
            {
                return Err(Error::Conflict("同一发布的依赖声明不一致".into()));
            }
            for binding in dependency.bindings {
                if !existing.bindings.iter().any(|value| {
                    value.component_id == binding.component_id
                        && value.config_pointer == binding.config_pointer
                        && value.entry == binding.entry
                }) {
                    existing.bindings.push(binding);
                }
            }
        } else {
            target.dependencies.push(dependency);
        }
    }
    Ok(())
}

impl FilePluginDependencies {
    pub(super) fn resolve(&self, target: DependencyTarget) -> Result<ResolvedTarget> {
        plugin_id(&target.id)?;
        let records = releases_at(&self.root)?;
        let owners: Vec<_> = records
            .iter()
            .filter(|record| {
                if target.kind == DependencyTargetKind::Release {
                    record.id == target.id
                } else {
                    record.components.iter().any(|component| {
                        component.id == target.id && component_kind(component.kind) == target.kind
                    })
                }
            })
            .collect();
        if owners.len() > 1 {
            return Err(Error::Conflict("组件属于多个完整发布".into()));
        }
        let mut manifest = DependencyManifest::default();
        let mut digest = Sha256::new();
        let mut components = Vec::new();
        let mut publication_identity = None;
        let canonical = if let Some(record) = owners.first() {
            let value: Value = files::json(
                &self
                    .root
                    .join("installations/manifests")
                    .join(format!("{}.json", record.revision)),
            )?;
            if value.get("id").and_then(Value::as_str) != Some(record.id.as_str()) {
                return Err(Error::Invalid("持久发布清单身份不一致".into()));
            }
            digest.update(record.revision.as_bytes());
            digest.update(
                serde_json::to_vec(&value)
                    .map_err(|_| Error::Storage("发布清单编码失败".into()))?,
            );
            publication_identity = Some(publication_digest(&self.root, record)?);
            if let Some(dependencies) = value.get("dependencies") {
                merge(
                    &mut manifest,
                    serde_json::from_value(dependencies.clone())
                        .map_err(|_| Error::Invalid("发布依赖声明无效".into()))?,
                    None,
                )?;
            }
            let origin_path = self
                .root
                .join("installations/dependency-origins")
                .join(format!("{}.json", record.revision));
            if origin_path.exists() {
                let origin: Value = files::json(&origin_path)?;
                let base = origin
                    .get("base_url")
                    .and_then(Value::as_str)
                    .and_then(|url| reqwest::Url::parse(url).ok())
                    .ok_or_else(|| Error::Invalid("持久依赖市场来源无效".into()))?;
                for source in manifest
                    .dependencies
                    .iter_mut()
                    .flat_map(|dependency| &mut dependency.sources)
                {
                    if source.kind == SourceKind::Market
                        && reqwest::Url::parse(&source.url).is_err()
                    {
                        let resolved = base
                            .join(&source.url)
                            .map_err(|_| Error::Invalid("市场依赖相对地址无效".into()))?;
                        if resolved.origin() != base.origin() {
                            return Err(Error::Invalid("依赖资源必须与市场清单同源".into()));
                        }
                        source.url = resolved.to_string();
                    }
                }
                digest.update(base.as_str().as_bytes());
            }
            for component in &record.components {
                components.push(Component {
                    kind: component_kind(component.kind),
                    id: component.id.clone(),
                    deployment_digest: String::new(),
                    runtime: None,
                });
            }
            DependencyTarget {
                kind: DependencyTargetKind::Release,
                id: record.id.clone(),
            }
        } else {
            if target.kind == DependencyTargetKind::Release {
                return Err(Error::NotFound("完整发布未安装".into()));
            }
            components.push(Component {
                kind: target.kind,
                id: target.id.clone(),
                deployment_digest: String::new(),
                runtime: None,
            });
            target
        };
        for component in &mut components {
            let directory = component_root(self, component.kind, &component.id)?;
            component.deployment_digest = deployment_digest(&directory)?;
            let runtime_path = directory.join(".deviceforge-runtime.json");
            if runtime_path.exists() {
                let runtime: RuntimeMetadata = files::json(&runtime_path)?;
                if runtime.format_version != 1 {
                    return Err(Error::Invalid("组件运行时元数据版本无效".into()));
                }
                component.runtime = Some(runtime.dependency);
            }
            digest.update(component.deployment_digest.as_bytes());
            let path = directory.join("dependencies.json");
            digest.update(component.id.as_bytes());
            // 无旁置声明的旧组件保留其资源路径，不能从旧 tools 推断新的安装任务。
            if path.exists() {
                let sidecar: DependencyManifest = files::json(&path)?;
                digest.update(
                    serde_json::to_vec(&sidecar)
                        .map_err(|_| Error::Storage("组件依赖声明编码失败".into()))?,
                );
                merge(&mut manifest, sidecar, Some(&component.id))?;
            }
        }
        manifest.validate().map_err(Error::Invalid)?;
        for component in &components {
            if let Some(runtime) = &component.runtime
                && !manifest.dependencies.iter().any(|dependency| {
                    dependency.id == runtime.id
                        && dependency.required
                        && dependency.entries.contains(&runtime.entry)
                })
            {
                return Err(Error::Invalid(
                    "组件运行时必须引用公开依赖中的必需工具和已声明入口".into(),
                ));
            }
        }
        let mut destinations = BTreeMap::new();
        for dependency in &manifest.dependencies {
            for binding in &dependency.bindings {
                if !components
                    .iter()
                    .any(|component| component.id == binding.component_id)
                {
                    return Err(Error::Invalid("依赖绑定引用发布之外的组件".into()));
                }
                let previous = destinations.insert(
                    (binding.component_id.clone(), binding.config_pointer.clone()),
                    dependency.id.clone(),
                );
                if previous.is_some_and(|id| id != dependency.id) {
                    return Err(Error::Conflict("多个依赖覆盖同一配置入口".into()));
                }
            }
        }
        Ok(ResolvedTarget {
            target: canonical,
            revision: format!("{:x}", digest.finalize()),
            manifest,
            components,
            publication_identity,
        })
    }

    pub(super) fn targets(&self) -> Result<Vec<DependencyTarget>> {
        let records = releases_at(&self.root)?;
        let mut targets: Vec<_> = records
            .iter()
            .map(|record| DependencyTarget {
                kind: DependencyTargetKind::Release,
                id: record.id.clone(),
            })
            .collect();
        for (kind, roots) in [
            (DependencyTargetKind::Server, &self.server_roots),
            (DependencyTargetKind::Browser, &self.browser_roots),
        ] {
            for root in roots {
                for (count, entry) in fs::read_dir(root).map_err(files::io)?.enumerate() {
                    if count >= 2048 {
                        return Err(Error::TooLarge);
                    }
                    let entry = entry.map_err(files::io)?;
                    let id = entry.file_name().to_string_lossy().into_owned();
                    if id.starts_with('.') || !entry.file_type().map_err(files::io)?.is_dir() {
                        continue;
                    }
                    plugin_id(&id)?;
                    if records.iter().any(|record| {
                        record.components.iter().any(|component| {
                            component.id == id && component_kind(component.kind) == kind
                        })
                    }) {
                        continue;
                    }
                    if entry.path().join("dependencies.json").exists()
                        || super::state::path(
                            &self.root,
                            &DependencyTarget {
                                kind,
                                id: id.clone(),
                            },
                        )
                        .exists()
                    {
                        targets.push(DependencyTarget { kind, id });
                    }
                    if targets.len() > 1024 {
                        return Err(Error::TooLarge);
                    }
                }
            }
        }
        Ok(targets)
    }
}

pub(super) fn deployment_digest(directory: &Path) -> Result<String> {
    let mut digest = Sha256::new();
    let mut found = false;
    for name in [
        "manifest.json",
        "package.json",
        "dependencies.json",
        "installation.json",
        ".deviceforge-runtime.json",
    ] {
        let path = directory.join(name);
        if path.exists() {
            let value: Value = files::json(&path)?;
            digest.update(name.as_bytes());
            digest.update(
                serde_json::to_vec(&value)
                    .map_err(|_| Error::Storage("部署身份编码失败".into()))?,
            );
            found = true;
        }
    }
    if !found {
        return Err(Error::Invalid("组件缺少可核对的部署清单身份".into()));
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub(super) fn publication_digest(root: &Path, record: &InstalledRelease) -> Result<String> {
    let manifest: Value = files::json(
        &root
            .join("installations/manifests")
            .join(format!("{}.json", record.revision)),
    )?;
    let bytes = serde_json::to_vec(&(&record.id, &record.revision, manifest))
        .map_err(|_| Error::Storage("发布身份编码失败".into()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
