use crate::{Error, Result};
use std::{
    fs::{File, Metadata, OpenOptions},
    path::{Component, Path},
};

pub(super) fn regular(path: &Path, directory: bool) -> Result<Metadata> {
    let value = path.to_str().ok_or(Error::Invalid("资源路径须为UTF-8"))?;
    if value.trim().is_empty()
        || value.len() > 4096
        || value.chars().any(char::is_control)
        || !path.is_absolute()
        || value.split(['/', '\\']).any(|part| part == "..")
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(Error::Invalid("产物和工作路径须为无父路径的绝对路径"));
    }
    let mut found = None;
    for ancestor in path.ancestors() {
        let metadata =
            std::fs::symlink_metadata(ancestor).map_err(|_| Error::Io("资源路径无法读取"))?;
        if metadata.file_type().is_symlink()
            || reparse(&metadata)
            || (!metadata.is_dir() && !metadata.is_file())
        {
            return Err(Error::Invalid("资源路径经过链接、重解析点或特殊文件"));
        }
        if ancestor == path {
            if metadata.is_dir() != directory || (!directory && !metadata.is_file()) {
                return Err(Error::Invalid("资源路径类型不符合要求"));
            }
            found = Some(metadata);
        } else if !metadata.is_dir() {
            return Err(Error::Invalid("资源父路径不是普通目录"));
        }
    }
    found.ok_or(Error::Invalid("资源路径不存在"))
}

pub(super) fn reparse(metadata: &Metadata) -> bool {
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

pub(super) fn create(path: &Path) -> Result<File> {
    regular(path.parent().ok_or(Error::Invalid("文件没有父目录"))?, true)?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| Error::Io("资源文件无法独占创建"))
}

pub(super) fn opened(path: &Path, file: &File, expected: &Metadata) -> Result<()> {
    let actual = file.metadata().map_err(|_| Error::Io("文件句柄无法读取"))?;
    let current = regular(path, false)?;
    if !actual.is_file()
        || reparse(&actual)
        || actual.len() != expected.len()
        || current.len() != expected.len()
        || actual.modified().ok() != expected.modified().ok()
        || current.modified().ok() != expected.modified().ok()
        || actual.created().ok() != expected.created().ok()
        || current.created().ok() != expected.created().ok()
    {
        return Err(Error::Invalid("文件路径或元数据在准备期间改变"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regular_files_and_independent_creation_reject_wrong_types_and_existing_target() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("input.apk");
        let file = create(&path).unwrap();
        let metadata = regular(&path, false).unwrap();
        assert!(opened(&path, &file, &metadata).is_ok());
        assert!(create(&path).is_err());
        assert!(regular(root.path(), false).is_err());
        assert!(regular(&path, true).is_err());
    }

    #[test]
    fn source_length_changes_are_detected_before_tool_use() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("input.apk");
        std::fs::write(&path, b"first").unwrap();
        let metadata = regular(&path, false).unwrap();
        let file = File::open(&path).unwrap();
        std::fs::write(&path, b"changed-length").unwrap();
        assert!(opened(&path, &file, &metadata).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn verbatim_paths_reject_parent_segments_before_metadata() {
        for value in [
            r"\\?\C:\scratch\..\input.apk",
            r"\\?\C:\scratch/../input.apk",
        ] {
            assert!(matches!(
                regular(Path::new(value), false),
                Err(Error::Invalid(_))
            ));
        }
    }

    #[cfg(unix)]
    #[test]
    fn linked_source_or_parent_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("input.apk");
        std::fs::write(&source, b"input").unwrap();
        let linked = root.path().join("linked.apk");
        std::os::unix::fs::symlink(&source, &linked).unwrap();
        assert!(regular(&linked, false).is_err());
        let parent = root.path().join("parent");
        std::os::unix::fs::symlink(root.path(), &parent).unwrap();
        assert!(regular(&parent.join("input.apk"), false).is_err());
    }
}
