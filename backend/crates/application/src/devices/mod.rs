//! 设备目录与离散能力用例；复用原任务、贡献快照及插件取消树。
pub(crate) mod locks;
mod refresh;
mod registry;
pub(crate) mod rules;
#[cfg(test)]
mod tests;
use crate::Application;
use apk_domain::{Error, Job, Result, devices::*};
use std::sync::Arc;

pub struct DeviceService {
    app: Arc<Application>,
    refreshes: Arc<tokio::sync::Semaphore>,
}
impl DeviceService {
    pub fn new(app: Arc<Application>) -> Arc<Self> {
        Arc::new(Self {
            refreshes: app.device_refreshes.clone(),
            app,
        })
    }
    pub fn providers(&self) -> Vec<DeviceProviderInfo> {
        self.app.registry.providers()
    }
    pub fn directories(&self) -> Vec<DeviceDirectory> {
        self.app.registry.directories()
    }
    pub async fn invoke(&self, request: DeviceActionRequest) -> Result<Job> {
        if !request.input.is_object() || request.version == 0 {
            return Err(Error::Invalid(
                "动作 input 必须为对象，能力版本必须为正整数".into(),
            ));
        }
        apk_domain::plugins::plugin_id(&request.provider_id)?;
        apk_domain::identifier(&request.capability)?;
        if request.generation.is_empty() || request.generation.len() > 100 {
            return Err(Error::Invalid("提供者 generation 无效".into()));
        }
        let (_, registered) = self.app.registry.provider_operation(
            &request.provider_id,
            &request.generation,
            Some((&request.capability, request.version)),
        )?;
        let app = self.app.clone();
        let input = serde_json::json!({"device_id":request.device_id,"input":request.input});
        self.app
            .blocking(move || {
                app.submit_registered(&registered.operation.id.clone(), input, registered, None)
            })
            .await
    }
}
