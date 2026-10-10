//! 核对实际文件与每段目录，拒绝链接和Windows重解析点。
use crate::error::{Error, Result};
use deviceforge_plugin_runtime::InvocationContext;
use std::{fs::Metadata, path::Path};

pub(crate) fn reparse(metadata: &Metadata) -> bool {
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

pub(crate) async fn regular(
    path: &Path,
    directory: bool,
    context: &InvocationContext,
) -> Result<Metadata> {
    super::absolute(path)?;
    let mut found = None;
    for ancestor in path.ancestors() {
        let metadata = super::controlled(context, async {
            tokio::fs::symlink_metadata(ancestor)
                .await
                .map_err(|_| Error::Io("部署或产物路径无法读取"))
        })
        .await?;
        if metadata.file_type().is_symlink()
            || reparse(&metadata)
            || (!metadata.is_file() && !metadata.is_dir())
        {
            return Err(Error::Invalid("路径经过链接或特殊文件"));
        }
        if ancestor == path {
            if directory != metadata.is_dir() {
                return Err(Error::Invalid("路径类型不符合声明"));
            }
            found = Some(metadata);
        } else if !metadata.is_dir() {
            return Err(Error::Invalid("父路径不是目录"));
        }
    }
    found.ok_or(Error::Invalid("路径没有实际文件"))
}
