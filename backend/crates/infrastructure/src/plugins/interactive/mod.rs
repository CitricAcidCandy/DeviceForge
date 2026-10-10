//! 协议 5 的独立进程适配；普通任务、平台命令和宿主代际不进入此模块。
mod definition;
mod handles;
mod supervision;
mod transport;

use super::ProcessPlugin;
use apk_domain::{Result, interactive::*};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) use definition::{Validators, definitions};

struct Provider {
    manifest: apk_plugin_sdk::Manifest,
    artifacts: Option<Arc<dyn apk_domain::artifacts::ArtifactStore>>,
    unresolved: Arc<std::sync::atomic::AtomicBool>,
    definitions: Vec<SessionDefinition>,
    validators: Arc<Validators>,
}

pub(super) fn provider(plugin: &ProcessPlugin) -> Option<Arc<dyn SessionProvider>> {
    (!plugin.sessions.is_empty()).then(|| {
        Arc::new(Provider {
            manifest: plugin.manifest.clone(),
            artifacts: plugin.artifacts.clone(),
            unresolved: plugin.unresolved.clone(),
            definitions: plugin.sessions.clone(),
            validators: plugin.session_validators.clone(),
        }) as Arc<dyn SessionProvider>
    })
}

// provider 只分配有界队列；进程、副本和握手由可跟踪的监督 Future 执行。
impl SessionProvider for Provider {
    fn definitions(&self) -> Vec<SessionDefinition> {
        self.definitions.clone()
    }

    fn has_unresolved_resources(&self) -> bool {
        self.unresolved.load(std::sync::atomic::Ordering::Acquire)
    }

    fn open(&self, request: SessionRequest, cancel: CancellationToken) -> Result<SessionLaunch> {
        definition::request(&self.validators, &request)?;
        if self.has_unresolved_resources() {
            return Err(apk_domain::Error::CleanupFailed);
        }
        let cancel = cancel.child_token();
        let (handle, channels) = handles::channel(request.deadline, cancel.clone());
        let call = supervision::Call {
            manifest: self.manifest.clone(),
            artifacts: self.artifacts.clone(),
            unresolved: self.unresolved.clone(),
            request,
            cancel,
            channels,
        };
        Ok(SessionLaunch {
            handle: Box::new(handle),
            supervisor: Box::pin(supervision::run(call)),
        })
    }
}
