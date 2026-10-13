use super::Loaded;
use crate::{
    bridge::{native, transport::Identity},
    cleanup::Cleanup,
    config::Config,
    model::PROFILE,
    resources::Resources,
    supervision::Launch,
};
use deviceforge_plugin_runtime::InvocationContext;
use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::{Mutex, oneshot};

fn node_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{value}"));
        }
        if let Some(value) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(value);
        }
    }
    path
}

fn unavailable(reason: &str) -> Loaded {
    Loaded {
        loaded: false,
        scope_complete: true,
        reason: Some(reason.into()),
    }
}

pub async fn sdk(config: Arc<Config>, context: InvocationContext, worker: PathBuf) -> Loaded {
    if context.check().is_err() {
        return unavailable("官方SDK加载探测已取消或到期");
    }
    let worker = match tokio::fs::canonicalize(worker).await {
        Ok(worker) => node_path(worker).with_file_name("probe.js"),
        Err(_) => return unavailable("包内SDK worker入口未准备"),
    };
    let probe = match tokio::fs::canonicalize(worker).await {
        Ok(probe) => node_path(probe),
        Err(_) => return unavailable("包内SDK加载探测入口未准备"),
    };
    let Some((project_id, project_root)) = config.projects.iter().next() else {
        return unavailable("SDK加载探测缺少已登记项目");
    };
    let resources = Resources::new(config.clone(), project_id.clone(), project_root.clone());
    let identity = Identity::create();
    let mut environment = BTreeMap::from([
        ("DF_SDK_PROFILE".into(), PROFILE.into()),
        ("DF_SDK_CALL_ID".into(), identity.call_id.clone()),
        ("DF_SDK_NONCE".into(), identity.nonce.clone()),
        (
            "DF_SDK_SDK_ENTRY".into(),
            config.sdk_entry.to_string_lossy().into_owned(),
        ),
    ]);
    if let Ok(root) = std::env::var("SystemRoot") {
        environment.insert("SystemRoot".into(), root);
    }
    let launch = Launch {
        format_version: 1,
        call_id: identity.call_id,
        nonce: identity.nonce,
        node: config.node_executable.clone(),
        worker: probe,
        environment,
    };
    let stop = context.cancellation().child_token();
    let cleanup = Arc::new(Cleanup::default());
    let (ready, ready_receiver) = oneshot::channel();
    let report = native::run(
        launch,
        context.clone(),
        stop.clone(),
        cleanup,
        resources,
        Arc::new(Mutex::new(None)),
        ready,
    );
    tokio::pin!(report);
    let until = tokio::time::Instant::from_std(context.deadline())
        .min(tokio::time::Instant::now() + Duration::from_secs(5));
    let report = tokio::select! {
        biased;
        report = &mut report => report,
        _ = tokio::time::sleep_until(until) => {
            stop.cancel();
            report.await
        }
    };
    let ready_received = ready_receiver.await.is_ok();
    let loaded = ready_received
        && report.scope_complete
        && report.outcome.is_ok()
        && context.check().is_ok();
    Loaded {
        loaded,
        scope_complete: report.scope_complete,
        reason: report
            .outcome
            .err()
            .or_else(|| (!ready_received).then(|| "官方SDK加载探测缺少监督启动身份".into()))
            .or_else(|| (!loaded).then(|| "官方SDK加载探测没有成功资格".into())),
    }
}
