use crate::{
    artifact_files::{LIMIT, Materialized, Temporary, materialize_until},
    execution_deadline,
};
use apk_domain::{
    Error, Result,
    artifacts::{Artifact, ArtifactStore},
};
use apk_plugin_sdk::{ArtifactAccess, ArtifactContext, ArtifactInput, ArtifactOutput};
use futures_util::TryStreamExt;
use std::{collections::HashSet, path::PathBuf, sync::Arc, time::Duration};
use tokio::time::Instant;
use tokio_util::{io::ReaderStream, sync::CancellationToken};
mod selectors;
use selectors::MAX_FILES;
const TIMEOUT: Duration = Duration::from_secs(120);

pub(crate) fn validate(access: &ArtifactAccess) -> Result<()> {
    selectors::validate(access)
}
pub(crate) struct InvocationFiles {
    pub directory: Arc<Temporary>,
    pub output: Option<PathBuf>,
    pub context: ArtifactContext,
    _inputs: Vec<Materialized>,
}
impl InvocationFiles {
    pub async fn prepare(
        store: Option<&dyn ArtifactStore>,
        access: Option<&ArtifactAccess>,
        input: &serde_json::Value,
        cancel: CancellationToken,
    ) -> Result<Self> {
        Self::prepare_until(store, access, input, cancel, None).await
    }

    pub async fn prepare_until(
        store: Option<&dyn ArtifactStore>,
        access: Option<&ArtifactAccess>,
        input: &serde_json::Value,
        cancel: CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<Self> {
        execution_deadline::check(&cancel, deadline)?;
        // 全部选择器及值先完成纯校验，坏输入不能触发存储或临时目录副作用。
        let selected = access
            .map(|access| selectors::select(access, input))
            .transpose()?
            .unwrap_or_default();
        execution_deadline::check(&cancel, deadline)?;
        if (!selected.is_empty() || access.is_some_and(|access| access.outputs)) && store.is_none()
        {
            return Err(Error::Dependency("插件产物存储未配置".into()));
        }
        let directory = Arc::new(Temporary::new()?);
        let mut inputs = Vec::new();
        let mut references = Vec::new();
        let mut total = 0u64;
        for selected in selected {
            let store = store.expect("已检查选中输入的存储依赖");
            let id = selected.artifact_id;
            let metadata = execution_deadline::run(&cancel, deadline, store.get(id)).await?;
            total = total.checked_add(metadata.size).ok_or(Error::TooLarge)?;
            if total > LIMIT {
                return Err(Error::TooLarge);
            }
            let file = materialize_until(
                store,
                id,
                &[
                    ".apk", ".apks", ".aab", ".hap", ".zip", ".png", ".json", ".msgpack",
                ],
                cancel.clone(),
                deadline,
            )
            .await?;
            references.push(ArtifactInput {
                field: selected.field.into(),
                artifact_id: file.artifact.id.clone(),
                filename: file.artifact.filename.clone(),
                size: file.artifact.size,
                sha256: file.artifact.sha256.clone(),
                path: file.path.to_string_lossy().into_owned(),
            });
            inputs.push(file);
        }
        let output = if access.is_some_and(|access| access.outputs) {
            if store.is_none() {
                return Err(Error::Dependency("插件产物存储未配置".into()));
            }
            let path = directory.path().join("outputs");
            execution_deadline::run(&cancel, deadline, async {
                tokio::fs::create_dir(&path)
                    .await
                    .map_err(|e| Error::Storage(e.to_string()))
            })
            .await?;
            Some(
                execution_deadline::run(&cancel, deadline, async {
                    tokio::fs::canonicalize(path)
                        .await
                        .map_err(|e| Error::Storage(e.to_string()))
                })
                .await?,
            )
        } else {
            None
        };
        let context = ArtifactContext {
            inputs: references,
            output_directory: output
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
        };
        execution_deadline::check(&cancel, deadline)?;
        Ok(Self {
            directory,
            output,
            context,
            _inputs: inputs,
        })
    }
    pub async fn publish(
        &self,
        store: Option<&dyn ArtifactStore>,
        outputs: Vec<ArtifactOutput>,
        cancel: CancellationToken,
    ) -> Result<Vec<Artifact>> {
        self.publish_until(store, outputs, cancel, None).await
    }

    pub async fn publish_until(
        &self,
        store: Option<&dyn ArtifactStore>,
        outputs: Vec<ArtifactOutput>,
        cancel: CancellationToken,
        deadline: Option<Instant>,
    ) -> Result<Vec<Artifact>> {
        execution_deadline::check(&cancel, deadline)?;
        if outputs.is_empty() {
            return Ok(Vec::new());
        }
        if outputs.len() > MAX_FILES {
            return Err(Error::Invalid("单次插件最多生成 8 个产物".into()));
        }
        let root = self
            .output
            .as_ref()
            .ok_or_else(|| Error::Invalid("插件未获产物输出授权".into()))?;
        let store = store.ok_or_else(|| Error::Dependency("插件产物存储未配置".into()))?;
        let mut names = HashSet::new();
        let mut total = 0u64;
        let mut paths = Vec::new();
        for output in &outputs {
            execution_deadline::check(&cancel, deadline)?;
            let media_type = crate::artifacts::media_type(&output.filename)?;
            if !names.insert(output.filename.to_ascii_lowercase()) {
                return Err(Error::Invalid("插件输出文件名重复".into()));
            }
            let path = root.join(&output.filename);
            let metadata = execution_deadline::run(&cancel, deadline, async {
                tokio::fs::symlink_metadata(&path)
                    .await
                    .map_err(|e| Error::Storage(e.to_string()))
            })
            .await?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || execution_deadline::run(&cancel, deadline, async {
                    tokio::fs::canonicalize(&path)
                        .await
                        .map_err(|e| Error::Storage(e.to_string()))
                })
                .await?
                    != path
            {
                return Err(Error::Invalid("插件输出必须为输出目录内的普通文件".into()));
            }
            total = total.checked_add(metadata.len()).ok_or(Error::TooLarge)?;
            if total > LIMIT {
                return Err(Error::TooLarge);
            }
            let check_path = path.clone();
            let guard = self.directory.clone();
            let validation_cancel = cancel.clone();
            execution_deadline::run(&cancel, deadline, async {
                tokio::task::spawn_blocking(move || {
                    // 等待 Future 丢弃后，验证仍持有目录；不能宣称阻塞工作已停止。
                    let _guard = guard;
                    execution_deadline::check(&validation_cancel, deadline)?;
                    crate::artifacts::validation::validate_content(&check_path, media_type)
                })
                .await
                .map_err(|e| Error::Dependency(e.to_string()))?
            })
            .await?;
            paths.push(path);
        }
        let mut artifacts = Vec::new();
        for (output, path) in outputs.into_iter().zip(paths) {
            let file = execution_deadline::run(&cancel, deadline, async {
                tokio::fs::File::open(path)
                    .await
                    .map_err(|e| Error::Storage(e.to_string()))
            })
            .await?;
            let stream = ReaderStream::new(file).map_err(|e| Error::Storage(e.to_string()));
            let publish_deadline = deadline.unwrap_or_else(|| Instant::now() + TIMEOUT);
            let artifact = execution_deadline::run(
                &cancel,
                Some(publish_deadline),
                store.put(output.filename, Box::pin(stream)),
            )
            .await?;
            artifacts.push(artifact);
        }
        execution_deadline::check(&cancel, deadline)?;
        Ok(artifacts)
    }
}

#[cfg(test)]
mod tests;
