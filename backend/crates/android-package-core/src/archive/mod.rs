mod copy;
mod index;
pub(crate) mod io_control;
mod packing;
pub mod paths;
mod preflight;
pub mod tree;

use crate::{ArchiveProfile, Control, Error, Result, profiles::MAX_SELECTED_NAME_BYTES};
use io_control::{CheckedReader, Fault};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    sync::Arc,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveEntry {
    pub name: String,
    pub size: u64,
    pub compressed_size: u64,
    pub directory: bool,
}

/// 只由实际容器读取或树扫描产生；公开描述不是全成员 CRC 证明。
#[derive(Debug)]
pub struct Directory {
    entries: Vec<ArchiveEntry>,
    declared_size: u64,
}

impl Directory {
    pub fn entries(&self) -> &[ArchiveEntry] {
        &self.entries
    }
    pub fn declared_size(&self) -> u64 {
        self.declared_size
    }
}

#[derive(Debug)]
pub struct Archive {
    file: File,
    metadata: Arc<zip::read::ZipArchiveMetadata>,
    indices: BTreeMap<String, usize>,
    directory: Directory,
    file_size: u64,
}

impl Archive {
    pub fn open(mut file: File, profile: ArchiveProfile, control: &Control<'_>) -> Result<Self> {
        control.check()?;
        let (directory, file_size) = index::read(&mut file, profile, control)?;
        preflight::seek(&mut file, 0, control)?;
        control.check()?;
        let fault = Fault::default();
        let mut reader = fault.zip(zip::ZipArchive::new(CheckedReader {
            inner: file,
            control,
            fault: &fault,
        }))?;
        let mut observed = BTreeSet::new();
        for entry in &directory.entries {
            control.check()?;
            observed.insert((
                entry.name.as_str(),
                entry.size,
                entry.compressed_size,
                entry.directory,
            ));
        }
        let mut indices = BTreeMap::new();
        for index in 0..reader.len() {
            control.check()?;
            let entry = fault.zip(reader.by_index(index))?;
            if !paths::safe_entry(entry.name())
                || entry
                    .unix_mode()
                    .is_some_and(|mode| ![0, 0o100000, 0o040000].contains(&(mode & 0o170000)))
                || !observed.contains(&(
                    entry.name(),
                    entry.size(),
                    entry.compressed_size(),
                    entry.is_dir(),
                ))
            {
                return Err(Error::InvalidArchive("解码目录与原始观测不一致"));
            }
            indices.insert(entry.name().to_owned(), index);
        }
        control.check()?;
        drop(observed);
        let metadata = reader.metadata();
        let file = reader.into_inner().inner;
        Ok(Self {
            file,
            metadata,
            indices,
            directory,
            file_size,
        })
    }

    pub fn directory(&self) -> &Directory {
        &self.directory
    }
    pub fn file_size(&self) -> u64 {
        self.file_size
    }

    pub(crate) fn member_index(&self, name: &str) -> Result<usize> {
        self.indices
            .get(name)
            .copied()
            .ok_or(Error::InvalidArchive("观测成员无法定位"))
    }

    pub(crate) fn reader<'a, 'c>(
        &'a mut self,
        control: &'a Control<'c>,
        fault: &'a Fault,
    ) -> zip::ZipArchive<CheckedReader<'a, 'c, &'a mut File>> {
        // 安全性：元数据来自当前持有的同一 File，不接收外部元数据或替换句柄。
        // 同一句柄不保证字节不变；调用方须在 Archive 生命周期内保持内容稳定。
        // 这是复用解码元数据的输入假设，不是不可变快照或并发改写保护。
        unsafe {
            zip::ZipArchive::unsafe_new_with_metadata(
                CheckedReader {
                    inner: &mut self.file,
                    control,
                    fault,
                },
                self.metadata.clone(),
            )
        }
    }

    pub fn select_exact<'a>(
        &'a mut self,
        name: &str,
        control: &Control<'_>,
    ) -> Result<SelectedEntry<'a>> {
        control.check()?;
        if name.len() > MAX_SELECTED_NAME_BYTES || !paths::safe_entry(name) {
            return Err(Error::InvalidArgument("精确条目名必须有界且路径安全"));
        }
        let mut matches = self
            .directory
            .entries
            .iter()
            .filter(|entry| entry.name == name);
        let entry = matches.next().ok_or(Error::EntryMissing)?;
        if matches.next().is_some() {
            return Err(Error::EntryDuplicate);
        }
        if entry.directory {
            return Err(Error::InvalidArgument("不能复制目录条目"));
        }
        let entry = entry.clone();
        control.check()?;
        Ok(SelectedEntry {
            archive: self,
            entry,
        })
    }
}

/// 借用原容器且不可自行构造，不允许拿另一容器的索引读取。
#[derive(Debug)]
pub struct SelectedEntry<'a> {
    archive: &'a mut Archive,
    entry: ArchiveEntry,
}
