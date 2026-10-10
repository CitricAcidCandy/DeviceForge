//! 普通文件与祖先目录核验；拒绝链接、特殊文件及Windows重解析点。
use crate::{Error, Result};
use deviceforge_plugin_runtime::InvocationContext;
use std::{fs::Metadata, path::Path};

fn reparse(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

pub(super) async fn regular(path: &Path, context: &InvocationContext) -> Result<Metadata> {
    super::absolute(path)?;
    let mut found = None;
    for ancestor in path.ancestors() {
        let metadata = super::reading::controlled(context, async {
            tokio::fs::symlink_metadata(ancestor)
                .await
                .map_err(|_| Error::Io("配置或工具路径无法读取"))
        })
        .await?;
        if metadata.file_type().is_symlink()
            || reparse(&metadata)
            || (!metadata.is_file() && !metadata.is_dir())
        {
            return Err(Error::Invalid("配置或工具路径经过链接或特殊文件"));
        }
        if ancestor == path {
            if !metadata.is_file() {
                return Err(Error::Invalid("配置或工具入口不是普通文件"));
            }
            found = Some(metadata);
        } else if !metadata.is_dir() {
            return Err(Error::Invalid("配置或工具父路径不是目录"));
        }
    }
    found.ok_or(Error::Invalid("配置或工具入口没有实际文件"))
}
