//! HTTP 与 MCP 的公共装配，仅向同一调试用例注入原宿主能力。
use super::{ApiError, tools};
use apk_application::{
    Application, debugger::DebuggerService, plugin_installations::InstallationService,
    plugin_lifecycle::PluginService,
};
use apk_domain::{artifacts::ArtifactStore, plugins::PluginInfo};
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::sync::Arc;

fn reload_expected(
    plugins: Arc<PluginService>,
    installations: Option<Arc<InstallationService>>,
    id: String,
    generation: String,
    cancel: tokio_util::sync::CancellationToken,
    context: apk_domain::ExecutionContext,
) -> BoxFuture<'static, apk_domain::Result<PluginInfo>> {
    Box::pin(async move {
        if let Some(installations) = installations {
            let deadline = context.deadline.ok_or(apk_domain::Error::Timeout)?;
            let releases = tokio::select! { biased;
                _ = cancel.cancelled() => return Err(apk_domain::Error::Cancelled),
                releases = tokio::time::timeout_at(deadline.into(), installations.list()) =>
                    releases.map_err(|_| apk_domain::Error::Timeout)??,
            };
            if releases.iter().any(|release| {
                release.components.iter().any(|component| {
                    component.kind == apk_domain::plugin_packages::PackageKind::Server
                        && component.id == id
                })
            }) {
                return installations
                    .reload_component_expected(id, generation, cancel, context)
                    .await;
            }
        }
        plugins
            .reload_expected_with_execution(id, generation, cancel, context)
            .await
    })
}

pub(crate) async fn invoke(
    app: &Arc<Application>,
    plugins: Option<&Arc<PluginService>>,
    debugger: &Arc<DebuggerService>,
    installations: Option<&Arc<InstallationService>>,
    artifacts: Option<&dyn ArtifactStore>,
    diagnostics: Option<&dyn tools::DebuggerDiagnostics>,
    name: &str,
    input: Value,
) -> Result<Value, ApiError> {
    let installations = installations.cloned();
    let reloader = move |plugins, id, generation, cancel, context| {
        reload_expected(
            plugins,
            installations.clone(),
            id,
            generation,
            cancel,
            context,
        )
    };
    tools::invoke_with_ports(
        app,
        plugins,
        debugger,
        tools::DebuggerPorts {
            artifacts,
            diagnostics,
            reload_expected: Some(&reloader),
        },
        name,
        input,
    )
    .await
}
