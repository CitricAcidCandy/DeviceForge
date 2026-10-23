//! 设备阶段更新；不在台账写入失败后继续创建资源。
use super::{Device, Stage, recovery};
use std::sync::Arc;

pub(super) enum Resource {
    Directory,
    Upload,
    Forward,
    Server,
}

impl Device {
    pub(super) fn tool_lease(&self) -> Option<Arc<recovery::ledger::ToolLease>> {
        self.ledger.as_ref().map(|ledger| ledger.lease.clone())
    }

    pub(super) async fn stage(&mut self, resource: Resource, stage: Stage) -> Result<(), String> {
        let Some(ledger) = self.ledger.as_mut() else {
            return Ok(());
        };
        match resource {
            Resource::Directory => ledger.record.directory_stage = stage,
            Resource::Upload => ledger.record.upload_stage = stage,
            Resource::Forward => ledger.record.forward_stage = stage,
            Resource::Server => ledger.record.server_stage = stage,
        }
        ledger.record.port = self.port;
        ledger.save().await
    }
}
