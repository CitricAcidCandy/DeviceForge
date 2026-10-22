//! 服务器插件配置独立于包部署保存，兼容旧配置并为调用提供不可变文件。
mod annotations;
mod migration;
mod resources;
mod rules;
mod storage;
use apk_domain::{Error, Result, plugin_configurations::*, plugins::plugin_id};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use storage::State;
use tokio::sync::Semaphore;

pub(crate) fn validate_definition(value: &apk_plugin_sdk::ConfigurationDefinition) -> Result<()> {
    rules::definition(value).map(|_| ())
}

#[derive(Clone)]
pub struct FilePluginConfigurations {
    root: PathBuf,
    deployment: Vec<PathBuf>,
    legacy: Vec<PathBuf>,
    _lock: Arc<fs::File>,
    _legacy_locks: Arc<Vec<fs::File>>,
    changes: Arc<Mutex<()>>,
    workers: Arc<Semaphore>,
}

impl FilePluginConfigurations {
    pub async fn open(root: &Path, deployment: &Path) -> Result<Arc<Self>> {
        Self::open_with_legacy(root, deployment, Vec::new()).await
    }

    pub async fn open_with_legacy(
        root: &Path,
        deployment: &Path,
        legacy: Vec<PathBuf>,
    ) -> Result<Arc<Self>> {
        Self::open_with_deployments(root, vec![deployment.to_owned()], legacy).await
    }

    pub async fn open_with_deployments(
        root: &Path,
        deployments: Vec<PathBuf>,
        legacy: Vec<PathBuf>,
    ) -> Result<Arc<Self>> {
        let root = root.to_owned();
        tokio::task::spawn_blocking(move || {
            fs::create_dir_all(&root).map_err(|_| Error::Storage("配置根目录创建失败".into()))?;
            let root =
                fs::canonicalize(root).map_err(|_| Error::Storage("配置根目录不可访问".into()))?;
            let mut deployment = Vec::new();
            for path in deployments {
                let path = fs::canonicalize(path)
                    .map_err(|_| Error::Storage("插件部署目录不可访问".into()))?;
                if root.starts_with(&path) || path.starts_with(&root) {
                    return Err(Error::Invalid("配置根目录必须独立于插件部署目录".into()));
                }
                if !deployment.contains(&path) {
                    deployment.push(path);
                }
            }
            if deployment.is_empty() {
                return Err(Error::Invalid("缺少插件部署目录".into()));
            }
            let lock_path = root.join(".configurations.lock");
            if let Ok(metadata) = fs::symlink_metadata(&lock_path)
                && (!metadata.is_file() || storage::linked(&metadata))
            {
                return Err(Error::Invalid("配置存储锁必须为普通文件".into()));
            }
            let lock = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(lock_path)
                .map_err(|_| Error::Storage("配置存储锁不可访问".into()))?;
            lock.try_lock()
                .map_err(|_| Error::Conflict("配置目录已由其他宿主占用".into()))?;
            let mut sources = Vec::new();
            let mut legacy_locks = Vec::new();
            for source in legacy {
                if !source.exists() {
                    continue;
                }
                let source = fs::canonicalize(source)
                    .map_err(|_| Error::Storage("历史配置目录不可访问".into()))?;
                if source == root || sources.contains(&source) {
                    continue;
                }
                let lock_path = source.join(".configurations.lock");
                if lock_path.exists() {
                    let metadata = fs::symlink_metadata(&lock_path)
                        .map_err(|_| Error::Storage("历史配置锁不可访问".into()))?;
                    if !metadata.is_file() || storage::linked(&metadata) {
                        return Err(Error::Invalid("历史配置锁必须为普通文件".into()));
                    }
                    let old_lock = fs::OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(lock_path)
                        .map_err(|_| Error::Storage("历史配置锁不可访问".into()))?;
                    old_lock.try_lock().map_err(|_| {
                        Error::Conflict("旧宿主仍占用历史插件配置，请先正常停止旧宿主".into())
                    })?;
                    legacy_locks.push(old_lock);
                }
                sources.push(source);
            }
            Ok(Arc::new(Self {
                root,
                deployment,
                legacy: sources,
                _lock: Arc::new(lock),
                _legacy_locks: Arc::new(legacy_locks),
                changes: Arc::new(Mutex::new(())),
                workers: Arc::new(Semaphore::new(2)),
            }))
        })
        .await
        .map_err(|_| Error::Storage("配置存储初始化异常".into()))?
    }

    async fn work<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Self) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let permit = self
            .workers
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("配置工作池已满".into()))?;
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let _change = store
                .changes
                .lock()
                .map_err(|_| Error::Storage("配置状态异常".into()))?;
            work(&store)
        })
        .await
        .map_err(|_| Error::Storage("配置文件工作异常".into()))?
    }

    fn manifest(&self, id: &str) -> Result<apk_plugin_sdk::Manifest> {
        plugin_id(id)?;
        let directory = self.deployment_directory(id)?;
        let metadata =
            fs::symlink_metadata(&directory).map_err(|_| Error::NotFound("插件尚未部署".into()))?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || fs::canonicalize(&directory)
                .map_err(|_| Error::Storage("插件目录不可访问".into()))?
                != directory
        {
            return Err(Error::Invalid("插件目录必须为普通部署目录".into()));
        }
        let manifest: apk_plugin_sdk::Manifest = storage::json(&directory.join("manifest.json"))?;
        if manifest.id != id {
            return Err(Error::Invalid("插件配置身份与部署不一致".into()));
        }
        Ok(manifest)
    }

    fn deployment_directory(&self, id: &str) -> Result<PathBuf> {
        self.deployment
            .iter()
            .map(|root| root.join(id))
            .find(|path| path.join("manifest.json").exists())
            .ok_or_else(|| Error::NotFound("插件尚未部署".into()))
    }

    fn read(&self, id: &str) -> Result<(Option<ConfigurationDefinition>, State)> {
        let manifest = self.manifest(id)?;
        let definition = manifest
            .configuration
            .as_ref()
            .map(rules::definition)
            .transpose()?;
        let state_path = self.root.join(id).join("state.json");
        migration::import(&self.root, &self.legacy, id)?;
        if state_path.exists() {
            storage::checked_directory(&self.root, id, false)?;
            let state: State = storage::json(&state_path)?;
            return Ok((definition, state));
        }
        let mut values = definition
            .as_ref()
            .map(|value| value.defaults.clone())
            .unwrap_or_else(|| json!({}));
        let configured = manifest
            .args
            .iter()
            .enumerate()
            .find_map(|(index, argument)| {
                argument
                    .strip_prefix("--config=")
                    .map(PathBuf::from)
                    .or_else(|| {
                        (argument == "--config")
                            .then(|| manifest.args.get(index + 1).map(PathBuf::from))
                            .flatten()
                    })
            });
        let executable_directory = Path::new(&manifest.executable)
            .parent()
            .unwrap_or(&self.deployment[0]);
        let legacy = configured
            .map(|path| {
                if path.is_absolute() {
                    path
                } else {
                    executable_directory.join(path)
                }
            })
            .unwrap_or_else(|| {
                executable_directory.join(
                    definition
                        .as_ref()
                        .and_then(|value| value.legacy_filename.as_deref())
                        .unwrap_or("config.json"),
                )
            });
        let source = if legacy.exists() {
            let old: Value = storage::json(&legacy)?;
            if !old.is_object() {
                return Err(Error::Invalid("旧插件配置必须为 JSON 对象".into()));
            }
            if definition
                .as_ref()
                .map(|definition| rules::errors(definition, &old))
                .transpose()?
                .is_some_and(|errors| errors.is_empty())
            {
                // 完整有效的旧配置就是用户原值，不能合入互斥默认项或示例条目。
                values = old;
            } else {
                // 兼容缺少新声明必填项的历史记录，保留旧值并补齐声明默认值。
                rules::merge(&mut values, &old);
            }
            ConfigurationSource::Legacy
        } else {
            ConfigurationSource::Defaults
        };
        let definition_version = definition.as_ref().map_or(0, |value| value.version);
        let sensitive_paths = definition
            .as_ref()
            .map(|definition| rules::sensitive_paths(&values, &definition.schema))
            .unwrap_or_default();
        let state = State {
            definition_version,
            revision: 0,
            applied_revision: 0,
            values,
            source,
            sensitive_paths,
        };
        if definition.is_some() {
            storage::ensure_revision(&self.root, id, 0, &state.values)?;
            storage::write(&state_path, &state)?;
        }
        Ok((definition, state))
    }

    fn view(
        id: &str,
        definition: Option<ConfigurationDefinition>,
        state: State,
    ) -> Result<PluginConfiguration> {
        let mut field_errors = definition
            .as_ref()
            .map(|definition| rules::errors(definition, &state.values))
            .transpose()?
            .unwrap_or_default();
        if definition
            .as_ref()
            .is_some_and(|definition| definition.version != state.definition_version)
        {
            field_errors.push(ConfigurationFieldError {
                path: String::new(),
                message: "配置版本与插件声明不一致，请检查并保存以确认升级".into(),
            });
        }
        let pending_reload = definition
            .as_ref()
            .is_some_and(|value| value.apply_policy == ConfigurationApplyPolicy::PluginReload)
            && state.revision != state.applied_revision;
        let mut values = state.values;
        let mut definition = definition;
        if let Some(definition) = &mut definition {
            rules::mask(&mut values, &definition.schema);
            rules::mask(&mut definition.defaults, &definition.schema);
            rules::mask_paths(&mut definition.defaults, &state.sensitive_paths);
            rules::mask_schema(&mut definition.schema);
            if let Some(value) = definition.schema.get_mut("default") {
                rules::mask_paths(value, &state.sensitive_paths);
            }
            if let Some(examples) = definition
                .schema
                .get_mut("examples")
                .and_then(Value::as_array_mut)
            {
                for value in examples {
                    rules::mask_paths(value, &state.sensitive_paths);
                }
            }
        } else {
            // 无声明旧插件不能可靠识别敏感字段，保留只读兼容入口而不回传原值。
            values = json!({});
        }
        rules::mask_paths(&mut values, &state.sensitive_paths);
        Ok(PluginConfiguration {
            kind: "server".into(),
            id: id.into(),
            compatible: field_errors.is_empty(),
            field_errors,
            definition,
            values,
            revision: state.revision,
            applied_revision: state.applied_revision,
            pending_reload,
            source: state.source,
        })
    }

    fn save(&self, id: &str, expected: u64, patch: Option<Value>) -> Result<PluginConfiguration> {
        let (definition, mut state) = self.read(id)?;
        if state.revision != expected {
            return Err(Error::Conflict("配置已被其他页面修改，请刷新后重试".into()));
        }
        let definition = definition
            .ok_or_else(|| Error::Conflict("旧插件未声明配置模式，不能统一编辑".into()))?;
        let mut values = state.values.clone();
        let editing = patch.is_some();
        if let Some(mut patch) = patch {
            if !patch.is_object() {
                return Err(Error::Invalid("配置合并补丁必须为对象".into()));
            }
            rules::preserve_mask(&mut patch, &values, &definition.schema);
            rules::preserve_paths(&mut patch, &values, &state.sensitive_paths);
            rules::merge(&mut values, &patch);
        } else {
            values = definition.defaults.clone();
        }
        let mut field_errors = rules::errors(&definition, &values)?;
        if editing {
            field_errors.extend(rules::readonly_errors(
                &state.values,
                &values,
                &definition.schema,
            ));
        }
        if !field_errors.is_empty() {
            let mut view = Self::view(id, Some(definition), state)?;
            view.compatible = false;
            view.field_errors = field_errors;
            return Ok(view);
        }
        if state.revision >= 1023 {
            return Err(Error::Conflict(
                "配置修订达到保留上限，请管理员归档历史后重试".into(),
            ));
        }
        storage::ensure_revision(&self.root, id, state.revision, &state.values)?;
        state.revision += 1;
        while storage::revision_path(&self.root, id, state.revision).exists() {
            state.revision += 1;
            if state.revision >= 1024 {
                return Err(Error::Conflict("配置修订达到保留上限".into()));
            }
        }
        state.definition_version = definition.version;
        state
            .sensitive_paths
            .extend(rules::sensitive_paths(&values, &definition.schema));
        state.sensitive_paths.sort();
        state.sensitive_paths.dedup();
        state.values = values;
        state.source = ConfigurationSource::Managed;
        storage::ensure_revision(&self.root, id, state.revision, &state.values)?;
        if definition.apply_policy == ConfigurationApplyPolicy::NextInvocation {
            state.applied_revision = state.revision;
        }
        storage::write(&self.root.join(id).join("state.json"), &state)?;
        Self::view(id, Some(definition), state)
    }
}

#[async_trait::async_trait]
impl PluginConfigurationStore for FilePluginConfigurations {
    async fn list(&self) -> Result<Vec<PluginConfiguration>> {
        self.work(|store| {
            let mut output = Vec::new();
            for deployment in &store.deployment {
                for (count, entry) in fs::read_dir(deployment)
                    .map_err(|_| Error::Storage("插件配置目录读取失败".into()))?
                    .enumerate()
                {
                    if count >= 1024 {
                        return Err(Error::TooLarge);
                    }
                    let entry = entry.map_err(|_| Error::Storage("插件配置条目读取失败".into()))?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.starts_with('.')
                        || !entry
                            .file_type()
                            .map_err(|_| Error::Storage("插件目录类型读取失败".into()))?
                            .is_dir()
                    {
                        continue;
                    }
                    if output
                        .iter()
                        .any(|value: &PluginConfiguration| value.id == name)
                        || !entry.path().join("manifest.json").exists()
                    {
                        continue;
                    }
                    let (definition, state) = store.read(&name)?;
                    output.push(Self::view(&name, definition, state)?);
                    if output.len() > 256 {
                        return Err(Error::TooLarge);
                    }
                }
            }
            output.sort_by(|left, right| left.id.cmp(&right.id));
            Ok(output)
        })
        .await
    }
    async fn get(&self, id: &str) -> Result<PluginConfiguration> {
        let id = id.to_owned();
        self.work(move |store| {
            let (definition, state) = store.read(&id)?;
            Self::view(&id, definition, state)
        })
        .await
    }
    async fn patch(&self, id: &str, expected: u64, patch: Value) -> Result<PluginConfiguration> {
        let id = id.to_owned();
        self.work(move |store| store.save(&id, expected, Some(patch)))
            .await
    }
    async fn reset(&self, id: &str, expected: u64) -> Result<PluginConfiguration> {
        let id = id.to_owned();
        self.work(move |store| store.save(&id, expected, None))
            .await
    }
    async fn mark_applied(&self, id: &str, expected: u64) -> Result<PluginConfiguration> {
        let id = id.to_owned();
        self.work(move |store| {
            let (definition, mut state) = store.read(&id)?;
            if state.revision != expected {
                return Err(Error::Conflict("配置修订已变化，请刷新后重试".into()));
            }
            let definition =
                definition.ok_or_else(|| Error::Conflict("旧插件未声明统一配置".into()))?;
            if state.definition_version != definition.version
                || !rules::errors(&definition, &state.values)?.is_empty()
            {
                return Err(Error::Conflict("配置与当前插件不兼容，不能应用".into()));
            }
            storage::ensure_revision(&store.root, &id, state.revision, &state.values)?;
            state.applied_revision = state.revision;
            storage::write(&store.root.join(&id).join("state.json"), &state)?;
            Self::view(&id, Some(definition), state)
        })
        .await
    }
    async fn invocation_path(&self, id: &str) -> Result<Option<PathBuf>> {
        let id = id.to_owned();
        self.work(move |store| {
            let (definition, state) = store.read(&id)?;
            let Some(definition) = definition else {
                return Ok(None);
            };
            if state.definition_version != definition.version
                || (!rules::errors(&definition, &state.values)?.is_empty()
                    && state.revision == state.applied_revision)
            {
                return Err(Error::Conflict("配置与当前插件不兼容，请先修复配置".into()));
            }
            storage::ensure_revision(&store.root, &id, state.revision, &state.values)?;
            if !store.root.join(&id).join("state.json").exists() {
                storage::write(&store.root.join(&id).join("state.json"), &state)?;
            }
            let path = storage::revision_path(&store.root, &id, state.applied_revision);
            let values: Value = storage::json(&path)?;
            resources::effective(store, &id, state.applied_revision, path, values).map(Some)
        })
        .await
    }
    async fn resources_path(&self, id: &str) -> Result<Option<PathBuf>> {
        let id = id.to_owned();
        self.work(move |store| resources::path(store, &id)).await
    }
    async fn requirements_configured(&self, id: &str, pointers: &[String]) -> Result<bool> {
        let id = id.to_owned();
        let pointers = pointers.to_vec();
        self.work(move |store| {
            let (definition, state) = store.read(&id)?;
            let Some(definition) = definition else {
                return Ok(false);
            };
            if definition.version != state.definition_version
                || !rules::errors(&definition, &state.values)?.is_empty()
            {
                return Ok(false);
            }
            Ok(pointers.iter().all(|pointer| {
                state
                    .values
                    .pointer(pointer)
                    .is_some_and(|value| match value {
                        Value::Null => false,
                        Value::String(value) => !value.trim().is_empty(),
                        Value::Array(value) => !value.is_empty(),
                        Value::Object(value) => !value.is_empty(),
                        _ => true,
                    })
            }))
        })
        .await
    }
}
