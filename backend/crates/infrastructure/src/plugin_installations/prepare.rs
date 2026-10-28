//! 先完整准备全部组件与工具，再把单一发布事务交给应用层提交。
use super::{
    FilePluginInstallations, Stage, archive, content, fetch, paths, repository, storage,
    transaction,
};
use apk_domain::{
    Error, Operation, Result, now, plugin_installations::*, plugin_packages::PackageKind,
};
use std::{collections::BTreeMap, fs, path::PathBuf, sync::Arc};

pub(super) struct ComponentContent {
    pub info: InstalledComponent,
    pub staged: PathBuf,
}
pub(super) struct ToolContent {
    pub staged: PathBuf,
    pub destination: PathBuf,
}
pub(super) struct Prepared {
    pub store: Arc<FilePluginInstallations>,
    pub stage: Stage,
    pub info: InstalledRelease,
    pub components: Vec<ComponentContent>,
    pub tools: Vec<ToolContent>,
    pub operations: Vec<Operation>,
    pub identities: Vec<ResourceIdentity>,
    pub manifest: ReleaseManifest,
    pub dependency_base: Option<String>,
    pub offline: bool,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(super) struct ResourceIdentity {
    pub kind: String,
    pub id: String,
    pub version: String,
    pub platform: String,
    pub sha256: String,
}

pub(super) fn identities(manifest: &ReleaseManifest, revision: &str) -> Vec<ResourceIdentity> {
    let mut values = vec![ResourceIdentity {
        kind: "release".into(),
        id: manifest.id.clone(),
        version: manifest.version.clone(),
        platform: "all".into(),
        sha256: revision.into(),
    }];
    values.extend(manifest.components.iter().filter_map(|component| {
        selected(&component.variants, |variant| &variant.platform).map(|variant| ResourceIdentity {
            kind: match component.kind {
                PackageKind::Server => "server",
                PackageKind::Browser => "browser",
            }
            .into(),
            id: component.id.clone(),
            version: component.version.clone(),
            platform: platform(),
            sha256: variant.sha256.clone(),
        })
    }));
    values.extend(
        manifest
            .tools
            .iter()
            .filter(|_| manifest.format_version == 1)
            .filter_map(|tool| {
                selected(&tool.variants, |variant| &variant.platform).map(|variant| {
                    ResourceIdentity {
                        kind: "tool".into(),
                        id: tool.id.clone(),
                        version: tool.version.clone(),
                        platform: platform(),
                        sha256: variant.sha256.clone(),
                    }
                })
            }),
    );
    values
}

async fn validate_input_identities(
    store: &FilePluginInstallations,
    input: &fetch::ReleaseInput,
    identities: Vec<ResourceIdentity>,
) -> Result<()> {
    let offline = matches!(&input.origin, fetch::Origin::Offline(_));
    let id = input.manifest.id.clone();
    let revision = input.revision.clone();
    input
        .stage
        .work(store, move |store| {
            let current = if offline {
                storage::optional(store, &id)?
            } else {
                None
            };
            // 这里只判断准备资格；提交仍须在原文件事务锁内重新核对调用方 CAS。
            transaction::validate_identities(
                store,
                &identities,
                current.as_ref().map(|current| (current, revision.as_str())),
            )
        })
        .await
}

pub(super) fn platform() -> String {
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        value => value,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        value => value,
    };
    format!("{os}-{arch}")
}

fn selected<T>(values: &[T], platform_value: impl Fn(&T) -> &str) -> Option<&T> {
    let platform = platform();
    values
        .iter()
        .find(|value| platform_value(value) == platform)
        .or_else(|| values.iter().find(|value| platform_value(value) == "any"))
}

pub(super) async fn plan(
    store: &FilePluginInstallations,
    source: InstallSource,
) -> Result<InstallationPlan> {
    let input = fetch::input(store, source).await?;
    let mut actions = vec![PlanAction::Verify, PlanAction::Install];
    let mut issues = Vec::new();
    let mut resources = Vec::new();
    let mut download_size = 0u64;
    let mut downloads = std::collections::HashSet::new();
    let version_identities = identities(&input.manifest, &input.revision);
    if let Err(error) = validate_input_identities(store, &input, version_identities).await {
        if matches!(error, Error::Conflict(_)) {
            issues.push(PlanIssue {
                code: "version_conflict".into(),
                message: "同一标识和版本已绑定其他资源摘要，请发布新版本".into(),
                required: true,
            });
        } else {
            return Err(error);
        }
    }
    for component in &input.manifest.components {
        if let Some(variant) = selected(&component.variants, |variant| &variant.platform) {
            let reused = fetch::cached(store, &input.stage, &variant.sha256, variant.size)
                .await?
                .is_some();
            if !reused && downloads.insert(variant.sha256.clone()) {
                download_size = download_size
                    .checked_add(variant.size)
                    .ok_or(Error::TooLarge)?;
            }
            actions.push(if reused {
                PlanAction::Reuse
            } else {
                PlanAction::Download
            });
            resources.push(PlanResource {
                kind: match component.kind {
                    PackageKind::Server => "server",
                    PackageKind::Browser => "browser",
                }
                .into(),
                id: component.id.clone(),
                version: component.version.clone(),
                platform: platform(),
                sha256: variant.sha256.clone(),
                size: variant.size,
                reused,
                required: true,
            });
        } else {
            issues.push(PlanIssue {
                code: "unsupported_component_platform".into(),
                message: format!("组件 {} 不支持当前平台", component.id),
                required: true,
            });
        }
    }
    for tool in input
        .manifest
        .tools
        .iter()
        .filter(|_| input.manifest.format_version == 1)
    {
        if let Some(variant) = selected(&tool.variants, |variant| &variant.platform) {
            let relative = format!(
                "tools/{}/{}/{}/{}",
                tool.id,
                tool.version,
                platform(),
                variant.sha256
            );
            let reused = input
                .stage
                .work(store, move |store| {
                    let path = store.root.join(relative);
                    if !path.exists() {
                        return Ok(false);
                    }
                    let repository = repository::open(&store.root)?;
                    let reader = repository.read().map_err(repository::error)?;
                    let key = repository
                        .key_for_entry(&path.join("__entry__"))
                        .map_err(repository::error)?;
                    reader.verify(&key, &|| Ok(())).map_err(repository::error)?;
                    Ok(true)
                })
                .await?;
            let reused = reused
                || fetch::cached(store, &input.stage, &variant.sha256, variant.size)
                    .await?
                    .is_some();
            actions.push(if reused {
                PlanAction::Reuse
            } else {
                PlanAction::Download
            });
            if !reused && downloads.insert(variant.sha256.clone()) {
                download_size = download_size
                    .checked_add(variant.size)
                    .ok_or(Error::TooLarge)?;
            }
            resources.push(PlanResource {
                kind: "tool".into(),
                id: tool.id.clone(),
                version: tool.version.clone(),
                platform: platform(),
                sha256: variant.sha256.clone(),
                size: variant.size,
                reused,
                required: tool.required,
            });
        } else {
            issues.push(PlanIssue {
                code: "unsupported_tool_platform".into(),
                message: format!("工具 {} 没有当前平台资源", tool.id),
                required: tool.required,
            });
        }
    }
    for requirement in &input.manifest.requirements {
        issues.push(PlanIssue {
            code: "user_configuration".into(),
            message: requirement.title.clone(),
            required: requirement.required,
        });
    }
    let id = input.manifest.id.clone();
    if input
        .stage
        .work(store, move |store| storage::optional(store, &id))
        .await?
        .is_some()
    {
        actions.push(PlanAction::PreservePrevious);
    }
    Ok(InstallationPlan {
        id: input.manifest.id.clone(),
        version: input.manifest.version.clone(),
        revision: input.revision.clone(),
        actions,
        issues,
        resources,
        download_size,
    })
}

pub(super) async fn prepare(
    store: &FilePluginInstallations,
    source: InstallSource,
) -> Result<Box<dyn PreparedInstallation>> {
    prepare_reported(store, source, Arc::new(apk_domain::NoProgress)).await
}

pub(super) async fn prepare_reported(
    store: &FilePluginInstallations,
    source: InstallSource,
    progress: Arc<dyn apk_domain::ProgressReporter>,
) -> Result<Box<dyn PreparedInstallation>> {
    let input = fetch::input(store, source).await?;
    let version_identities = identities(&input.manifest, &input.revision);
    validate_input_identities(store, &input, version_identities.clone()).await?;
    let mut components = Vec::new();
    if let fetch::Origin::Offline(root) = &input.origin
        && let Some(dependencies) = &input.manifest.dependencies
    {
        let mut cached = std::collections::BTreeSet::new();
        for source in dependencies
            .dependencies
            .iter()
            .flat_map(|dependency| &dependency.sources)
        {
            if source.kind != deviceforge_plugin_dependencies::SourceKind::Market
                || reqwest::Url::parse(&source.url).is_ok()
                || !cached.insert(source.sha256.clone())
            {
                continue;
            }
            let path = root.join(&source.url);
            if path.is_file() {
                fetch::resource(
                    store,
                    &input,
                    10_000 + cached.len(),
                    &source.url,
                    source.size,
                    &source.sha256,
                    progress.clone(),
                )
                .await?;
            }
        }
    }
    let mut operations = Vec::new();
    let mut tools = Vec::new();
    let mut installed_tools = Vec::new();
    let mut bindings = ResourceBindings {
        format_version: 1,
        release_id: input.manifest.id.clone(),
        revision: input.revision.clone(),
        tools: BTreeMap::new(),
        bindings: Vec::new(),
    };
    let mut index = 0usize;
    for component in &input.manifest.components {
        let variant = selected(&component.variants, |variant| &variant.platform)
            .ok_or_else(|| Error::Invalid(format!("组件 {} 不支持当前平台", component.id)))?;
        let downloaded = fetch::resource(
            store,
            &input,
            index,
            &variant.path,
            variant.size,
            &variant.sha256,
            progress.clone(),
        )
        .await?;
        progress
            .report(apk_domain::JobProgress {
                stage: apk_domain::JobStage::Verifying,
                resource_id: Some(component.id.clone()),
                completed_bytes: variant.size,
                total_bytes: Some(variant.size),
            })
            .await?;
        let staged = input.stage.path().join(format!("component-{index}"));
        index += 1;
        let target = staged.clone();
        let declaration = component.clone();
        let revision = input.revision.clone();
        let dependencies = input.manifest.dependencies.clone();
        let format = variant.format;
        let (info, contribution) = input.stage.work(store, move |store| {
            fs::create_dir(&target).map_err(|_| Error::Storage("组件暂存创建失败".into()))?;
            archive::extract(&downloaded, &target, format, true)?;
            let parent = match declaration.kind {PackageKind::Server => "plugins", PackageKind::Browser => "browser-plugins"};
            let final_directory = store.root.join(parent).join(&declaration.id).join("revisions").join(&revision);
            // 既有便携映射函数会追加 ID，这里使用临时目录映射后替换绝对程序前缀。
            let (package, operations) = crate::plugin_packages::manifest::validate_with_dependencies(&target, &target, declaration.kind, store.node.as_deref(), dependencies.as_ref())?;
            if package.id != declaration.id || package.version != declaration.version { return Err(Error::Invalid("组件便携清单身份或版本与发布不符".into())); }
            if declaration.kind == PackageKind::Server {
                let mut manifest: apk_plugin_sdk::Manifest = paths::read(&target.join("manifest.json"), 65_536)?;
                let temporary_prefix = target.join(&declaration.id).to_string_lossy().into_owned();
                let final_prefix = final_directory.to_string_lossy().into_owned();
                manifest.executable = manifest.executable.replacen(&temporary_prefix, &final_prefix, 1);
                if ["node", "script"].contains(&package.runtime.as_str()) && let Some(script) = manifest.args.first_mut() {
                    // Windows 的 Node 参数使用普通绝对路径，而不是扩展长度路径。
                    let mapped = final_directory.join(&package.entry_path).to_string_lossy().into_owned();
                    *script = mapped.strip_prefix(r"\\?\").unwrap_or(&mapped).to_owned();
                }
                paths::write(&target.join("manifest.json"), &manifest)?;
            } else {
                let package_manifest: apk_plugin_sdk::packages::PortablePackage = paths::read(&target.join("package.json"), 65_536)?;
                let source = paths::existing(&target, &package_manifest.deviceforge.manifest)?;
                let manifest: apk_plugin_sdk::packages::BrowserManifest = paths::read(&source, 65_536)?;
                paths::write(&target.join("manifest.json"), &manifest)?;
            }
            Ok((InstalledComponent {id: package.id, kind: declaration.kind, version: package.version, revision: revision.clone(), entry_path: package.entry_path.clone(), entry_url: (declaration.kind == PackageKind::Browser).then(|| format!("/api/v2/plugin-installations/browser/{}/revisions/{revision}/assets/{}", declaration.id, package.entry_path))}, operations))
        }).await?;
        operations.extend(contribution);
        components.push(ComponentContent { info, staged });
    }
    for tool in input
        .manifest
        .tools
        .iter()
        .filter(|_| input.manifest.format_version == 1)
    {
        let Some(variant) = selected(&tool.variants, |variant| &variant.platform) else {
            if tool.required {
                return Err(Error::Invalid(format!(
                    "必需工具 {} 不支持当前平台",
                    tool.id
                )));
            }
            continue;
        };
        let destination = store
            .root
            .join("tools")
            .join(&tool.id)
            .join(&tool.version)
            .join(platform())
            .join(&variant.sha256);
        let check = destination.clone();
        let entries = variant.entries.clone();
        let reused = input
            .stage
            .work(store, move |store| {
                if check.exists() {
                    let repository = repository::open(&store.root)?;
                    let reader = repository.read().map_err(repository::error)?;
                    let key = repository
                        .key_for_entry(&check.join("__entry__"))
                        .map_err(repository::error)?;
                    reader.verify(&key, &|| Ok(())).map_err(repository::error)?;
                    for entry in entries.values() {
                        paths::existing(&check, entry)?;
                    }
                    Ok(true)
                } else {
                    Ok(false)
                }
            })
            .await?;
        if !reused {
            let downloaded = fetch::resource(
                store,
                &input,
                index,
                &variant.path,
                variant.size,
                &variant.sha256,
                progress.clone(),
            )
            .await?;
            progress
                .report(apk_domain::JobProgress {
                    stage: apk_domain::JobStage::Verifying,
                    resource_id: Some(tool.id.clone()),
                    completed_bytes: variant.size,
                    total_bytes: Some(variant.size),
                })
                .await?;
            let staged = input.stage.path().join(format!("tool-{index}"));
            index += 1;
            let target = staged.clone();
            let variant = variant.clone();
            input
                .stage
                .work(store, move |_| {
                    fs::create_dir(&target)
                        .map_err(|_| Error::Storage("工具暂存创建失败".into()))?;
                    archive::extract(&downloaded, &target, variant.format, false)?;
                    for entry in variant.entries.values() {
                        paths::existing(&target, entry)?;
                    }
                    content::seal(&target)
                })
                .await?;
            tools.push(ToolContent {
                staged,
                destination: destination.clone(),
            });
        }
        bindings.tools.insert(
            tool.id.clone(),
            BoundTool {
                version: tool.version.clone(),
                platform: platform(),
                entries: variant
                    .entries
                    .iter()
                    .map(|(key, path)| {
                        (
                            key.clone(),
                            destination.join(path).to_string_lossy().into_owned(),
                        )
                    })
                    .collect(),
            },
        );
        bindings
            .bindings
            .extend(tool.bindings.iter().map(|binding| ResourceBinding {
                tool_id: tool.id.clone(),
                component_id: binding.component_id.clone(),
                config_pointer: binding.config_pointer.clone(),
                entry: binding.entry.clone(),
            }));
        installed_tools.push(InstalledTool {
            id: tool.id.clone(),
            version: tool.version.clone(),
            platform: platform(),
            sha256: variant.sha256.clone(),
            entries: variant.entries.keys().cloned().collect(),
        });
    }
    let revision = input.revision.clone();
    let summary: String = input.manifest.description.chars().take(500).collect();
    for component in &components {
        let directory = component.staged.clone();
        let binding_snapshot = bindings.clone();
        let client_id = component.info.id.clone();
        let metadata = serde_json::json!({"metadata_version":1,"id":component.info.id,"version":component.info.version,"kind":component.info.kind,"name":input.manifest.name,"title":input.manifest.name,"summary":summary,"description":input.manifest.description});
        let marker = serde_json::json!({"format_version":1,"release_id":input.manifest.id,"revision":revision,"component_id":component.info.id,"kind":component.info.kind});
        input
            .stage
            .work(store, move |store| {
                let mut binding_snapshot = serde_json::to_value(&binding_snapshot)
                    .map_err(|_| Error::Storage("资源绑定编码失败".into()))?;
                binding_snapshot["repository"] = serde_json::json!({"format_version":1,"root":store.root.join("tools"),"client_id":client_id});
                paths::write(&directory.join("resources.json"), &binding_snapshot)?;
                paths::write(&directory.join("market.json"), &metadata)?;
                paths::write(&directory.join("installation.json"), &marker)?;
                content::seal(&directory)
            })
            .await?;
    }
    let info = InstalledRelease {
        id: input.manifest.id.clone(),
        version: input.manifest.version.clone(),
        name: input.manifest.name.clone(),
        description: input.manifest.description.clone(),
        revision: input.revision.clone(),
        enabled: false,
        status: InstallationStatus::Installed,
        failure: None,
        installed_at: now(),
        components: components
            .iter()
            .map(|component| component.info.clone())
            .collect(),
        tools: installed_tools,
        requirements: input.manifest.requirements.clone(),
    };
    let dependency_base = match &input.origin {
        fetch::Origin::Market(base) => Some(base.to_string()),
        fetch::Origin::Offline(_) => None,
    };
    let offline = matches!(&input.origin, fetch::Origin::Offline(_));
    Ok(Box::new(Prepared {
        store: store
            .handle
            .upgrade()
            .ok_or_else(|| Error::Conflict("安装存储正在关闭".into()))?,
        stage: input.stage,
        info,
        components,
        tools,
        operations,
        identities: version_identities,
        manifest: input.manifest,
        dependency_base,
        offline,
    }))
}

#[async_trait::async_trait]
impl PreparedInstallation for Prepared {
    fn info(&self) -> &InstalledRelease {
        &self.info
    }
    fn operations(&self) -> &[Operation] {
        &self.operations
    }
    async fn commit(
        self: Box<Self>,
        expected_revision: Option<String>,
    ) -> Result<InstalledRelease> {
        let store = self.store.clone();
        store
            .work(move |store| transaction::commit(store, *self, expected_revision))
            .await
    }
}
