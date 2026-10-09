use crate::artifact_files::{LIMIT, Materialized, Temporary, materialize};
use apk_domain::{
    Error, Result,
    artifacts::{Artifact, ArtifactStore},
};
use apk_plugin_sdk::{ArtifactAccess, ArtifactContext, ArtifactInput, ArtifactOutput};
use futures_util::TryStreamExt;
use std::{collections::HashSet, path::PathBuf, sync::Arc, time::Duration};
use tokio_util::{io::ReaderStream, sync::CancellationToken};
const MAX_FILES: usize = 8;
const TIMEOUT: Duration = Duration::from_secs(120);

pub(crate) fn validate(access: &ArtifactAccess) -> Result<()> {
    let mut fields = HashSet::new();
    if access.input_fields.len() > MAX_FILES {
        return Err(Error::Invalid("插件产物输入字段最多 8 个".into()));
    }
    for field in &access.input_fields {
        if field.is_empty()
            || field.len() > 80
            || !field
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_')
            || !fields.insert(field)
        {
            return Err(Error::Invalid(
                "插件产物字段必须为唯一的顶层字段名称".into(),
            ));
        }
    }
    Ok(())
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
        let directory = Arc::new(Temporary::new()?);
        let mut inputs = Vec::new();
        let mut references = Vec::new();
        let mut total = 0u64;
        if let Some(access) = access {
            for field in &access.input_fields {
                let Some(value) = input.get(field) else {
                    continue;
                };
                let ids: Vec<&str> = if let Some(id) = value.as_str() {
                    vec![id]
                } else if let Some(values) = value.as_array() {
                    values
                        .iter()
                        .map(|value| {
                            value
                                .as_str()
                                .ok_or_else(|| Error::Invalid("产物 ID 数组必须只含字符串".into()))
                        })
                        .collect::<Result<_>>()?
                } else {
                    return Err(Error::Invalid("产物字段必须为 ID 字符串或 ID 数组".into()));
                };
                if ids.len() + inputs.len() > MAX_FILES {
                    return Err(Error::Invalid("单次插件最多读取 8 个产物".into()));
                }
                for id in ids {
                    let store =
                        store.ok_or_else(|| Error::Dependency("插件产物存储未配置".into()))?;
                    let metadata = store.get(id).await?;
                    total = total.checked_add(metadata.size).ok_or(Error::TooLarge)?;
                    if total > LIMIT {
                        return Err(Error::TooLarge);
                    }
                    let file = materialize(
                        store,
                        id,
                        &[
                            ".apk", ".apks", ".aab", ".hap", ".zip", ".png", ".json", ".msgpack",
                        ],
                        cancel.clone(),
                    )
                    .await?;
                    references.push(ArtifactInput {
                        field: field.clone(),
                        artifact_id: file.artifact.id.clone(),
                        filename: file.artifact.filename.clone(),
                        size: file.artifact.size,
                        sha256: file.artifact.sha256.clone(),
                        path: file.path.to_string_lossy().into_owned(),
                    });
                    inputs.push(file);
                }
            }
        }
        let output = if access.is_some_and(|access| access.outputs) {
            if store.is_none() {
                return Err(Error::Dependency("插件产物存储未配置".into()));
            }
            let path = directory.path().join("outputs");
            tokio::fs::create_dir(&path)
                .await
                .map_err(|e| Error::Storage(e.to_string()))?;
            Some(
                tokio::fs::canonicalize(path)
                    .await
                    .map_err(|e| Error::Storage(e.to_string()))?,
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
            let media_type = crate::artifacts::media_type(&output.filename)?;
            if !names.insert(output.filename.to_ascii_lowercase()) {
                return Err(Error::Invalid("插件输出文件名重复".into()));
            }
            let path = root.join(&output.filename);
            let metadata = tokio::fs::symlink_metadata(&path)
                .await
                .map_err(|e| Error::Storage(e.to_string()))?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || tokio::fs::canonicalize(&path)
                    .await
                    .map_err(|e| Error::Storage(e.to_string()))?
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
            tokio::task::spawn_blocking(move || {
                let _guard = guard;
                crate::artifacts::validation::validate_content(&check_path, media_type)
            })
            .await
            .map_err(|e| Error::Dependency(e.to_string()))??;
            paths.push(path);
        }
        let mut artifacts = Vec::new();
        for (output, path) in outputs.into_iter().zip(paths) {
            let file = tokio::fs::File::open(path)
                .await
                .map_err(|e| Error::Storage(e.to_string()))?;
            let stream = ReaderStream::new(file).map_err(|e| Error::Storage(e.to_string()));
            let artifact = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(Error::Cancelled),
                value = tokio::time::timeout(TIMEOUT,store.put(output.filename,Box::pin(stream))) => value.unwrap_or(Err(Error::Timeout))?,
            };
            artifacts.push(artifact);
        }
        Ok(artifacts)
    }
}

#[cfg(test)]
mod tests;
