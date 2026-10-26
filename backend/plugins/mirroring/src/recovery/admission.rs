//! 新调用只检查自己的登记条件，旧债务由后台恢复按资源续办。
use super::{ledger, store};
use std::path::Path;

pub(super) async fn check(root: &Path, device: &str) -> Result<(), String> {
    if !ledger::device_id(device) {
        return Err("新会话设备标识无效".into());
    }
    let root = root.to_owned();
    // 目录不可用是本次资源创建错误；历史台账、控制状态和外来工具不参与准入。
    store::io(move || store::prepare(&root)).await
}
