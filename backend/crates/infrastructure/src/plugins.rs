use crate::{execution_deadline, plugin_artifacts::InvocationFiles, process};
use apk_domain::{
    Error, ExecutionContext, Executor, ExecutorResultFormat, Operation, PluginArtifactResult,
    Result, artifacts::ArtifactStore,
};
use apk_plugin_sdk::context::CONTEXT_PROTOCOL_VERSION;
use apk_plugin_sdk::cooperative::COOPERATIVE_PROTOCOL_VERSION;
use apk_plugin_sdk::{ARTIFACT_PROTOCOL_VERSION, Manifest, PROTOCOL_VERSION, Request, Response};
use async_trait::async_trait;
use serde_json::Value;
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use tracing::Instrument;
mod execution;
mod performance;
mod process_cleanup;

pub struct ProcessPlugin {
    manifest: Manifest,
    artifacts: Option<Arc<dyn ArtifactStore>>,
    unresolved: Arc<AtomicBool>,
    devices: Option<apk_domain::devices::DeviceProviderDefinition>,
    performance: Option<apk_domain::performance::PerformanceSourceDefinition>,
}
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() < 100
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}
impl ProcessPlugin {
    pub fn new(manifest: Manifest) -> Result<Self> {
        if !matches!(
            manifest.protocol_version,
            PROTOCOL_VERSION
                | ARTIFACT_PROTOCOL_VERSION
                | COOPERATIVE_PROTOCOL_VERSION
                | CONTEXT_PROTOCOL_VERSION
        ) {
            return Err(Error::Invalid("插件协议版本不兼容".into()));
        }
        if !valid_name(&manifest.id)
            || manifest.id.starts_with("builtin.")
            || manifest.version.is_empty()
        {
            return Err(Error::Invalid("插件标识符或版本无效".into()));
        }
        if !Path::new(&manifest.executable).is_absolute()
            || !Path::new(&manifest.executable).is_file()
        {
            return Err(Error::Invalid("插件入口必须是存在的绝对文件路径".into()));
        }
        let mut names = std::collections::HashSet::new();
        for contribution in &manifest.operations {
            if !valid_name(&contribution.name) || !names.insert(&contribution.name) {
                return Err(Error::Conflict("插件操作名无效或重复".into()));
            }
        }
        if manifest.operations.is_empty() {
            return Err(Error::Invalid("插件没有贡献操作".into()));
        }
        if let Some(access) = &manifest.artifacts {
            if !matches!(
                manifest.protocol_version,
                ARTIFACT_PROTOCOL_VERSION | COOPERATIVE_PROTOCOL_VERSION | CONTEXT_PROTOCOL_VERSION
            ) {
                return Err(Error::Invalid("产物能力要求插件协议版本 2、3 或 4".into()));
            }
            crate::plugin_artifacts::validate(access)?;
        }
        execution::validate(&manifest)?;
        let operations = execution::operations(&manifest);
        let devices = manifest
            .devices
            .as_ref()
            .map(|access| crate::device_providers::definition(&manifest.id, access, &operations))
            .transpose()?;
        let performance = performance::definition(&manifest, &operations, devices.as_ref())?;
        Ok(Self {
            manifest,
            artifacts: None,
            unresolved: Arc::new(AtomicBool::new(false)),
            devices,
            performance,
        })
    }
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
    pub fn with_artifacts(manifest: Manifest, artifacts: Arc<dyn ArtifactStore>) -> Result<Self> {
        let mut plugin = Self::new(manifest)?;
        plugin.artifacts = Some(artifacts);
        Ok(plugin)
    }
}
pub fn load(directory: &Path) -> Result<Vec<Arc<dyn Executor>>> {
    Ok(load_inner(directory, None)?
        .into_iter()
        .map(|plugin| plugin as Arc<dyn Executor>)
        .collect())
}
pub fn load_with_artifacts(
    directory: &Path,
    artifacts: Arc<dyn ArtifactStore>,
) -> Result<Vec<Arc<dyn Executor>>> {
    Ok(load_process_with_artifacts(directory, artifacts)?
        .into_iter()
        .map(|plugin| plugin as Arc<dyn Executor>)
        .collect())
}
pub fn load_process_with_artifacts(
    directory: &Path,
    artifacts: Arc<dyn ArtifactStore>,
) -> Result<Vec<Arc<ProcessPlugin>>> {
    load_inner(directory, Some(artifacts))
}
fn load_inner(
    directory: &Path,
    artifacts: Option<Arc<dyn ArtifactStore>>,
) -> Result<Vec<Arc<ProcessPlugin>>> {
    let mut plugins: Vec<Arc<ProcessPlugin>> = Vec::new();
    if !directory.exists() {
        return Ok(plugins);
    }
    let mut paths = std::fs::read_dir(directory)
        .map_err(|e| Error::Dependency(e.to_string()))?
        .map(|entry| entry.map(|e| e.path()))
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| Error::Dependency(e.to_string()))?;
    paths.sort();
    for path in paths {
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        let bytes = std::fs::read(&manifest_path)
            .map_err(|e| Error::Dependency(format!("插件清单读取失败：{e}")))?;
        if bytes.len() > 64 * 1024 {
            return Err(Error::Invalid("插件清单超过 64 KiB".into()));
        }
        let manifest = serde_json::from_slice(&bytes).map_err(|e| Error::Invalid(e.to_string()))?;
        let mut plugin = ProcessPlugin::new(manifest)?;
        plugin.artifacts = artifacts.clone();
        plugins.push(Arc::new(plugin));
    }
    Ok(plugins)
}
#[async_trait]
impl Executor for ProcessPlugin {
    fn result_format(&self) -> ExecutorResultFormat {
        match self.manifest.protocol_version {
            ARTIFACT_PROTOCOL_VERSION | COOPERATIVE_PROTOCOL_VERSION | CONTEXT_PROTOCOL_VERSION => {
                ExecutorResultFormat::PublishedArtifacts
            }
            _ => ExecutorResultFormat::Json,
        }
    }
    fn device_provider(&self) -> Option<apk_domain::devices::DeviceProviderDefinition> {
        self.devices.clone()
    }
    fn performance_source(&self) -> Option<apk_domain::performance::PerformanceSourceDefinition> {
        self.performance.clone()
    }
    fn has_unresolved_resources(&self) -> bool {
        self.unresolved.load(Ordering::Acquire)
    }
    fn operations(&self) -> Vec<Operation> {
        execution::operations(&self.manifest)
    }
    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.execute_with_context(operation, input, cancel, ExecutionContext::default())
            .await
    }

    async fn execute_with_context(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let span = tracing::info_span!("插件调用", plugin_id = %self.manifest.id, plugin_version = %self.manifest.version, plugin_request_id = %id);
        async {
            let started = std::time::Instant::now();
            tracing::info!("插件调用开始");
            let result = self.invoke(operation, input, cancel, id, context).await;
            let code = result.as_ref().err().map(Error::code).unwrap_or("ok");
            tracing::info!(
                code,
                elapsed_us = started.elapsed().as_micros() as u64,
                "插件调用结束"
            );
            result
        }
        .instrument(span)
        .await
    }
}
impl ProcessPlugin {
    async fn invoke(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        id: String,
        context: ExecutionContext,
    ) -> Result<Value> {
        let deadline = context.deadline.map(tokio::time::Instant::from_std);
        execution_deadline::check(&cancel, deadline)?;
        let prefix = format!("plugin.{}.", self.manifest.id);
        let name = operation
            .strip_prefix(&prefix)
            .ok_or_else(|| Error::NotFound(operation.into()))?;
        if !self.manifest.operations.iter().any(|c| c.name == name) {
            return Err(Error::NotFound(operation.into()));
        }
        let sampling = self
            .performance
            .as_ref()
            .is_some_and(|source| source.operation == operation);
        let artifact_access = if sampling {
            None
        } else {
            self.manifest.artifacts.as_ref()
        };
        let files = if matches!(
            self.manifest.protocol_version,
            ARTIFACT_PROTOCOL_VERSION | COOPERATIVE_PROTOCOL_VERSION | CONTEXT_PROTOCOL_VERSION
        ) {
            let prepare_deadline =
                deadline.unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(120));
            Some(
                execution_deadline::run(&cancel, Some(prepare_deadline), async {
                    if deadline.is_some() {
                        InvocationFiles::prepare_until(
                            self.artifacts.as_deref(),
                            artifact_access,
                            &input,
                            cancel.clone(),
                            deadline,
                        )
                        .await
                    } else {
                        InvocationFiles::prepare(
                            self.artifacts.as_deref(),
                            artifact_access,
                            &input,
                            cancel.clone(),
                        )
                        .await
                    }
                })
                .await?,
            )
        } else {
            None
        };
        let request = Request {
            protocol_version: self.manifest.protocol_version,
            request_id: id.clone(),
            operation: name.into(),
            input,
            artifacts: files.as_ref().map(|files| files.context.clone()),
        };
        let mut bytes = serde_json::to_vec(&request).map_err(|e| Error::Invalid(e.to_string()))?;
        bytes.push(b'\n');
        if bytes.len() > 512 * 1024 {
            return Err(Error::Invalid("插件请求超过 512 KiB".into()));
        }
        execution_deadline::check(&cancel, deadline)?;
        let response = if matches!(
            self.manifest.protocol_version,
            COOPERATIVE_PROTOCOL_VERSION | CONTEXT_PROTOCOL_VERSION
        ) {
            let invocation = process::cooperative::Invocation {
                executable: &self.manifest.executable,
                args: &self.manifest.args,
                input: bytes,
                request_id: &id,
                cancel: cancel.clone(),
                directory: files.as_ref().map(|files| files.directory.path()),
                timeout: Duration::from_secs(3600),
                deadline: context.deadline,
            };
            if self.manifest.protocol_version == CONTEXT_PROTOCOL_VERSION {
                process::cooperative::run_with_context(invocation, self.unresolved.clone()).await?
            } else {
                process::cooperative::run(invocation, self.unresolved.clone()).await?
            }
        } else {
            let mut cleanup = process_cleanup::Guard::new(self.unresolved.clone());
            let result = if let Some(files) = &files {
                if let Some(deadline) = deadline {
                    process::run_plugin_until(
                        &self.manifest.executable,
                        &self.manifest.args,
                        bytes,
                        deadline,
                        cancel.clone(),
                        files.directory.path(),
                    )
                    .await
                } else {
                    process::run_plugin(
                        &self.manifest.executable,
                        &self.manifest.args,
                        bytes,
                        cancel.clone(),
                        files.directory.path(),
                    )
                    .await
                }
            } else if let Some(deadline) = deadline {
                process::run_until(
                    &self.manifest.executable,
                    &self.manifest.args,
                    Some(bytes),
                    deadline,
                    cancel.clone(),
                    true,
                )
                .await
            } else {
                process::run(
                    &self.manifest.executable,
                    &self.manifest.args,
                    Some(bytes),
                    Duration::from_secs(60),
                    cancel.clone(),
                    true,
                )
                .await
            };
            cleanup.observe(&result);
            let output = result?;
            let response: Response = serde_json::from_slice(&output)
                .map_err(|e| Error::Dependency(format!("插件响应协议无效：{e}")))?;
            response
        };
        if response.protocol_version != self.manifest.protocol_version || response.request_id != id
        {
            return Err(Error::Dependency("插件响应版本或请求 ID 不匹配".into()));
        }
        execution_deadline::check(&cancel, deadline)?;
        if sampling && !response.outputs.is_empty() {
            return Err(Error::Invalid("性能采样响应不得包含产物输出".into()));
        }
        let result = match (response.result, response.error) {
            (Some(result), None) => {
                let result = if self
                    .devices
                    .as_ref()
                    .is_some_and(|definition| definition.discover_operation == operation)
                {
                    crate::device_providers::discovery(
                        self.devices.as_ref().expect("已确认设备声明"),
                        result,
                    )?
                } else {
                    result
                };
                if let Some(files) = files {
                    let publish_deadline = deadline
                        .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(120));
                    let published =
                        execution_deadline::run(&cancel, Some(publish_deadline), async {
                            if deadline.is_some() {
                                files
                                    .publish_until(
                                        self.artifacts.as_deref(),
                                        response.outputs,
                                        cancel.clone(),
                                        deadline,
                                    )
                                    .await
                            } else {
                                files
                                    .publish(
                                        self.artifacts.as_deref(),
                                        response.outputs,
                                        cancel.clone(),
                                    )
                                    .await
                            }
                        })
                        .await?;
                    serde_json::to_value(PluginArtifactResult {
                        result,
                        artifacts: published,
                    })
                    .map_err(|e| Error::Dependency(e.to_string()))
                } else if response.outputs.is_empty() {
                    Ok(result)
                } else {
                    Err(Error::Invalid("协议版本 1 不支持产物输出".into()))
                }
            }
            (None, Some(error)) if !error.trim().is_empty() && response.outputs.is_empty() => {
                Err(Error::Dependency(error))
            }
            _ => Err(Error::Dependency(
                "插件响应必须只包含 result 或 error 之一".into(),
            )),
        }?;
        execution_deadline::check(&cancel, deadline)?;
        Ok(result)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_protocol_and_duplicate_names() {
        let mut manifest = Manifest {
            id: "test".into(),
            version: "0.1.0".into(),
            protocol_version: 99,
            executable: std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            args: vec![],
            performance: None,
            devices: None,
            artifacts: None,
            operations: vec![],
        };
        assert!(ProcessPlugin::new(manifest.clone()).is_err());
        manifest.protocol_version = 1;
        let contribution = apk_plugin_sdk::Contribution {
            name: "echo".into(),
            title: "回显".into(),
            input_schema: serde_json::json!({"type":"object"}),
            execution: None,
        };
        manifest.operations = vec![contribution.clone(), contribution];
        assert!(matches!(
            ProcessPlugin::new(manifest),
            Err(Error::Conflict(_))
        ));
    }
    #[test]
    fn artifact_capabilities_require_v2_and_unique_top_level_fields() {
        let base = serde_json::json!({"id":"test","version":"0.1.0","protocol_version":1,"executable":std::env::current_exe().unwrap(),"args":[],"operations":[{"name":"copy","title":"复制","input_schema":{"type":"object"}}],"artifacts":{"input_fields":["artifact_id"],"outputs":true}});
        let manifest: Manifest = serde_json::from_value(base.clone()).unwrap();
        assert!(ProcessPlugin::new(manifest).is_err());
        let mut value = base;
        value["protocol_version"] = serde_json::json!(2);
        assert!(ProcessPlugin::new(serde_json::from_value(value.clone()).unwrap()).is_ok());
        value["artifacts"]["input_fields"] = serde_json::json!(["id", "id"]);
        assert!(ProcessPlugin::new(serde_json::from_value(value).unwrap()).is_err());
    }

    #[test]
    fn nested_artifact_access_requires_v2_or_v3_and_cannot_bypass_performance_gate() {
        let mut value = serde_json::json!({
            "id":"probe","version":"1","protocol_version":2,
            "executable":std::env::current_exe().unwrap(),
            "operations":[{"name":"sample","title":"采样","input_schema":{"type":"object"}}],
            "artifacts":{"input_pointers":["/input/artifact_id"],"outputs":false}
        });
        for version in [2, 3] {
            value["protocol_version"] = serde_json::json!(version);
            assert!(ProcessPlugin::new(serde_json::from_value(value.clone()).unwrap()).is_ok());
        }
        value["protocol_version"] = serde_json::json!(1);
        assert!(matches!(
            ProcessPlugin::new(serde_json::from_value(value.clone()).unwrap()),
            Err(Error::Invalid(_))
        ));
        value["protocol_version"] = serde_json::json!(2);
        value["performance"] = serde_json::json!({"sample_operation":"sample"});
        for artifacts in [
            serde_json::json!({"input_fields":[],"input_pointers":["/input/artifact_id"],"outputs":false}),
            serde_json::json!({"input_fields":["artifact_id"],"input_pointers":[],"outputs":false}),
            serde_json::json!({"input_fields":[],"input_pointers":[],"outputs":true}),
        ] {
            value["artifacts"] = artifacts;
            assert!(matches!(
                ProcessPlugin::new(serde_json::from_value(value.clone()).unwrap()),
                Err(Error::Invalid(_))
            ));
        }
        value["artifacts"] =
            serde_json::json!({"input_fields":[],"input_pointers":[],"outputs":false});
        assert!(ProcessPlugin::new(serde_json::from_value(value).unwrap()).is_ok());
    }
}
