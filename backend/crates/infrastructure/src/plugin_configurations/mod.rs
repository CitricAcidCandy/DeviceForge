//! 服务器插件配置独立于包部署保存，兼容旧配置并为调用提供不可变文件。
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
    deployment: PathBuf,
    _lock: Arc<fs::File>,
    changes: Arc<Mutex<()>>,
    workers: Arc<Semaphore>,
}

impl FilePluginConfigurations {
    pub async fn open(root: &Path, deployment: &Path) -> Result<Arc<Self>> {
        let root = root.to_owned();
        let deployment = deployment.to_owned();
        tokio::task::spawn_blocking(move || {
            fs::create_dir_all(&root).map_err(|_| Error::Storage("配置根目录创建失败".into()))?;
            let root =
                fs::canonicalize(root).map_err(|_| Error::Storage("配置根目录不可访问".into()))?;
            let deployment = fs::canonicalize(deployment)
                .map_err(|_| Error::Storage("插件部署目录不可访问".into()))?;
            if root.starts_with(&deployment) || deployment.starts_with(&root) {
                return Err(Error::Invalid("配置根目录必须独立于插件部署目录".into()));
            }
            let lock = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(root.join(".configurations.lock"))
                .map_err(|_| Error::Storage("配置存储锁不可访问".into()))?;
            lock.try_lock()
                .map_err(|_| Error::Conflict("配置目录已由其他宿主占用".into()))?;
            Ok(Arc::new(Self {
                root,
                deployment,
                _lock: Arc::new(lock),
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
        let directory = self.deployment.join(id);
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

    fn read(&self, id: &str) -> Result<(Option<ConfigurationDefinition>, State)> {
        let manifest = self.manifest(id)?;
        let definition = manifest
            .configuration
            .as_ref()
            .map(rules::definition)
            .transpose()?;
        let state_path = self.root.join(id).join("state.json");
        if state_path.exists() {
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
            .unwrap_or(&self.deployment);
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
            rules::merge(&mut values, &old);
            ConfigurationSource::Legacy
        } else {
            ConfigurationSource::Defaults
        };
        let definition_version = definition.as_ref().map_or(0, |value| value.version);
        Ok((
            definition,
            State {
                definition_version,
                revision: 0,
                applied_revision: 0,
                values,
                source,
            },
        ))
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
            rules::mask_schema(&mut definition.schema);
        } else {
            // 无声明旧插件不能可靠识别敏感字段，保留只读兼容入口而不回传原值。
            values = json!({});
        }
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
            for (count, entry) in fs::read_dir(&store.deployment)
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
                let (definition, state) = store.read(&name)?;
                output.push(Self::view(&name, definition, state)?);
                if output.len() > 256 {
                    return Err(Error::TooLarge);
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
            // 首次显式保存前继续使用插件原有 --config 或旁置文件，不由读取接管配置。
            if !store.root.join(&id).join("state.json").exists() {
                return Ok(None);
            }
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
            let _: Value = storage::json(&path)?;
            Ok(Some(path))
        })
        .await
    }
}
