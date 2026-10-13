mod probes;

use crate::{
    config::Config,
    model::{NODE_VERSION, PROFILE, PROVIDER, SDK_VERSION},
    public_results::RuntimeStatus,
};
use apk_plugin_sdk::cooperative::CleanupOutcome;
use deviceforge_plugin_runtime::InvocationContext;
use std::{path::PathBuf, sync::Arc};

pub struct Report {
    pub status: RuntimeStatus,
    pub cleanup: CleanupOutcome,
}

pub fn unavailable(reason: impl Into<String>) -> RuntimeStatus {
    RuntimeStatus {
        provider: PROVIDER,
        sdk_version: SDK_VERSION,
        profile: PROFILE,
        configured: false,
        node_version: None,
        cli_version: None,
        sdk_loaded: false,
        process_scope_qualified: false,
        model_verified: false,
        ready: false,
        projects: Vec::new(),
        reason: Some(reason.into()),
        resource_scope: "sdk_worker_proxy_and_cli",
    }
}

fn aggregate(
    config: &Config,
    node: &probes::Version,
    cli: &probes::Version,
    sdk: &probes::Loaded,
    model: Result<bool, String>,
) -> RuntimeStatus {
    let configured = config.node_version == NODE_VERSION
        && config.cli_version == SDK_VERSION
        && config.sdk_version == SDK_VERSION
        && config.profile == PROFILE;
    let versions_match = node.version.as_deref() == Some(NODE_VERSION)
        && cli.version.as_deref() == Some(SDK_VERSION);
    let process_scope_qualified = node.scope_complete
        && node.cleanup_complete
        && cli.scope_complete
        && cli.cleanup_complete
        && sdk.scope_complete
        && sdk.loaded;
    let model_verified = model.as_ref().is_ok_and(|verified| *verified);
    let ready =
        configured && versions_match && sdk.loaded && process_scope_qualified && model_verified;
    let reason = if !configured {
        Some("SDK固定版本档案不符合".into())
    } else if let Some(reason) = node.reason.as_ref().or(cli.reason.as_ref()) {
        Some(reason.clone())
    } else if !versions_match {
        Some("实际Node或CLI版本不符合固定档案".into())
    } else if let Some(reason) = &sdk.reason {
        Some(reason.clone())
    } else if !sdk.loaded {
        Some("官方SDK实际加载探测未取得成功资格".into())
    } else if !process_scope_qualified {
        Some("当前平台完整进程范围探测未取得原生资格".into())
    } else if let Err(reason) = model {
        Some(reason)
    } else if !model_verified {
        Some("当前配置的完整模型轮次资格尚未提交".into())
    } else {
        None
    };
    RuntimeStatus {
        provider: PROVIDER,
        sdk_version: SDK_VERSION,
        profile: PROFILE,
        configured,
        node_version: node.version.clone(),
        cli_version: cli.version.clone(),
        sdk_loaded: sdk.loaded,
        process_scope_qualified,
        model_verified,
        ready,
        projects: config.projects.keys().cloned().collect(),
        reason,
        resource_scope: "sdk_worker_proxy_and_cli",
    }
}

pub async fn status(
    config: Option<Arc<Config>>,
    context: InvocationContext,
    worker: Result<PathBuf, String>,
) -> Report {
    let Some(config) = config else {
        return Report {
            status: unavailable("SDK部署配置未加载"),
            cleanup: CleanupOutcome::Complete,
        };
    };
    let sdk = async {
        match worker {
            Ok(worker) => probes::sdk(config.clone(), context.clone(), worker).await,
            Err(reason) => probes::Loaded {
                loaded: false,
                scope_complete: true,
                reason: Some(reason),
            },
        }
    };
    let (node, cli, sdk, model) = tokio::join!(
        probes::version(&config.node_executable, true, &context),
        probes::version(&config.cli_executable, false, &context),
        sdk,
        crate::qualification::verified((*config).clone(), context.clone()),
    );
    let cleanup = if node.cleanup_complete && cli.cleanup_complete && sdk.scope_complete {
        CleanupOutcome::Complete
    } else {
        CleanupOutcome::Failed
    };
    Report {
        status: aggregate(&config, &node, &cli, &sdk, model),
        cleanup,
    }
}

#[cfg(test)]
#[path = "runtime_status/tests.rs"]
mod tests;
