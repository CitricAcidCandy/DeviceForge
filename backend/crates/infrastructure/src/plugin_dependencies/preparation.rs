//! 准备引用跨越探测、下载与最终绑定提交；失败只释放本次独占引用。
use super::{FilePluginDependencies, repository_error};
use apk_domain::Result;
use deviceforge_tool_repository::{ToolKey, WriteGuard};

pub(super) struct Preparation {
    pub owner: String,
    pub keys: Vec<ToolKey>,
}

impl Preparation {
    pub fn new() -> Self {
        Self {
            owner: format!("dependency-prepare-{}", uuid::Uuid::new_v4()),
            keys: Vec::new(),
        }
    }

    pub fn with_key(&self, key: &ToolKey) -> Vec<ToolKey> {
        let mut keys = self.keys.clone();
        if !keys.contains(key) {
            keys.push(key.clone());
        }
        keys
    }

    pub fn retain_published(writer: &WriteGuard, owner: &str, keys: &[ToolKey]) -> Result<()> {
        writer.set_references(owner, keys).map_err(repository_error)
    }
}

impl FilePluginDependencies {
    pub(super) async fn release_preparation(&self, preparation: Preparation) {
        if preparation.keys.is_empty() {
            return;
        }
        let result = self
            .work(move |store| {
                // 只修改本次独占的引用文件，无需等待其他正在执行的工具退出。
                store
                    .repository
                    .read()
                    .map_err(repository_error)?
                    .clear_temporary_references(&preparation.owner)
                    .map_err(repository_error)
            })
            .await;
        if result.is_err() {
            tracing::warn!("依赖准备引用释放失败，保守保留本次引用待清理");
        }
    }
}
