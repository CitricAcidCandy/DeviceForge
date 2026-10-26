//! 依赖管理用例和任务共用入口，文件与进程副作用由领域端口实现。
use apk_domain::{
    Error, ExecutionContext, Executor, Operation, OperationExecution, OperationExecutionSource,
    ProgressReporter, Result, plugin_dependencies::*,
};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::{Arc, OnceLock, Weak};
use tokio_util::sync::CancellationToken;

pub struct DependencyService {
    store: Arc<dyn DependencyStore>,
    installations: OnceLock<Weak<crate::plugin_installations::InstallationService>>,
}

impl DependencyService {
    pub fn new(store: Arc<dyn DependencyStore>) -> Arc<Self> {
        Arc::new(Self {
            store,
            installations: OnceLock::new(),
        })
    }
    pub fn bind_installations(
        &self,
        service: &Arc<crate::plugin_installations::InstallationService>,
    ) -> Result<()> {
        self.installations
            .set(Arc::downgrade(service))
            .map_err(|_| Error::Conflict("依赖应用生命周期已绑定".into()))
    }
    pub async fn get(&self, target: DependencyTarget) -> Result<PluginDependencies> {
        apk_domain::plugins::plugin_id(&target.id)?;
        self.store.get(target).await
    }
    pub async fn forget(&self, target: DependencyTarget) -> Result<()> {
        apk_domain::plugins::plugin_id(&target.id)?;
        self.store.forget(target).await
    }
    /// 安装入口一次完成检测、共享复用和缺失必需依赖准备，不递归触发插件启用。
    pub async fn ensure(
        &self,
        target: DependencyTarget,
        cancel: CancellationToken,
        context: ExecutionContext,
        progress: Arc<dyn ProgressReporter>,
    ) -> Result<PluginDependencies> {
        let current = self.get(target.clone()).await?;
        let scanned = self
            .scan(
                DependencyRequest {
                    target,
                    expected_revision: current.revision,
                    dependency_ids: Vec::new(),
                },
                cancel.clone(),
                context,
                progress.clone(),
            )
            .await?;
        if scanned.ready {
            return Ok(scanned);
        }
        if !scanned.dependencies.iter().any(|dependency| {
            dependency.required
                && dependency.status != DependencyStatus::Ready
                && dependency.installable
        }) {
            return Ok(scanned);
        }
        self.store
            .install(
                DependencyRequest {
                    target: scanned.target,
                    expected_revision: scanned.revision,
                    dependency_ids: Vec::new(),
                },
                cancel,
                context,
                progress,
            )
            .await
    }
    pub async fn scan(
        &self,
        request: DependencyRequest,
        cancel: CancellationToken,
        context: ExecutionContext,
        progress: Arc<dyn ProgressReporter>,
    ) -> Result<PluginDependencies> {
        validate(&request)?;
        self.store.scan(request, cancel, context, progress).await
    }
    pub async fn scan_and_apply(
        &self,
        request: DependencyRequest,
        cancel: CancellationToken,
        context: ExecutionContext,
        progress: Arc<dyn ProgressReporter>,
    ) -> Result<PluginDependencies> {
        let result = self
            .scan(request, cancel.clone(), context, progress)
            .await?;
        self.apply_ready(&result, cancel).await?;
        Ok(result)
    }
    pub async fn install(
        &self,
        request: DependencyRequest,
        cancel: CancellationToken,
        context: ExecutionContext,
        progress: Arc<dyn ProgressReporter>,
    ) -> Result<PluginDependencies> {
        validate(&request)?;
        let result = self
            .store
            .install(request, cancel.clone(), context, progress)
            .await?;
        self.apply_ready(&result, cancel).await?;
        Ok(result)
    }
    async fn apply_ready(
        &self,
        result: &PluginDependencies,
        cancel: CancellationToken,
    ) -> Result<()> {
        if result.ready
            && result.target.kind == DependencyTargetKind::Release
            && let Some(installations) = self.installations.get().and_then(Weak::upgrade)
        {
            let current = installations.get(&result.target.id).await?;
            if current.enabled
                && matches!(
                    current.status,
                    apk_domain::plugin_installations::InstallationStatus::DependenciesRequired
                )
            {
                installations
                    .set_enabled_cancelled(current.id, current.revision, true, cancel)
                    .await?;
            }
        }
        Ok(())
    }
}

fn validate(request: &DependencyRequest) -> Result<()> {
    apk_domain::plugins::plugin_id(&request.target.id)?;
    apk_domain::plugin_installations::validate_release_digest(&request.expected_revision)?;
    if request.dependency_ids.len() > 128 {
        return Err(Error::TooLarge);
    }
    let mut ids = std::collections::BTreeSet::new();
    for id in &request.dependency_ids {
        apk_domain::plugins::plugin_id(id)?;
        if !ids.insert(id) {
            return Err(Error::Invalid("依赖标识重复".into()));
        }
    }
    Ok(())
}

pub struct DependencyOperations(pub Arc<DependencyService>);

#[async_trait]
impl Executor for DependencyOperations {
    fn operations(&self) -> Vec<Operation> {
        let schema = serde_json::to_value(
            schemars::SchemaGenerator::default().into_root_schema_for::<DependencyRequest>(),
        )
        .expect("依赖请求模式有效");
        [
            ("dependency.scan", "重新检测并自动配置插件依赖"),
            ("dependency.install", "安装缺失插件依赖并自动配置"),
        ]
        .into_iter()
        .map(|(id, title)| Operation {
            id: id.into(),
            title: title.into(),
            input_schema: schema.clone(),
            execution: Some(OperationExecution {
                api_version: 1,
                total_timeout_ms: 3_600_000,
                source: OperationExecutionSource::Declared,
            }),
        })
        .collect()
    }
    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        self.execute_with_context(operation, input, cancel, Default::default())
            .await
    }
    async fn execute_with_context(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> Result<Value> {
        self.execute_with_progress(
            operation,
            input,
            cancel,
            context,
            Arc::new(apk_domain::NoProgress),
        )
        .await
    }
    async fn execute_with_progress(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
        context: ExecutionContext,
        progress: Arc<dyn ProgressReporter>,
    ) -> Result<Value> {
        let request =
            serde_json::from_value(input).map_err(|_| Error::Invalid("依赖请求无效".into()))?;
        let result = match operation {
            "dependency.scan" => {
                self.0
                    .scan_and_apply(request, cancel, context, progress)
                    .await?
            }
            "dependency.install" => self.0.install(request, cancel, context, progress).await?,
            _ => return Err(Error::NotFound(operation.into())),
        };
        serde_json::to_value(result).map_err(|_| Error::Dependency("依赖结果编码失败".into()))
    }
}

#[cfg(test)]
#[path = "plugin_dependencies_tests.rs"]
mod tests;
