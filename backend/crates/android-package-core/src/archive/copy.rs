use super::SelectedEntry;
use super::io_control::Fault;
use crate::{Control, CopiedEntry, Error, IoStage, LimitKind, Result, profiles::MAX_FILE_BYTES};
use std::{
    fs::File,
    io::{Read, Seek, Write},
};

pub(super) fn empty_destination(file: &mut File, control: &Control<'_>) -> Result<()> {
    control.check()?;
    let metadata = file
        .metadata()
        .map_err(|e| Error::io(IoStage::Metadata, e))?;
    control.check()?;
    let position = file
        .stream_position()
        .map_err(|e| Error::io(IoStage::Seek, e))?;
    if !metadata.is_file() || metadata.len() != 0 || position != 0 {
        return Err(Error::InvalidArgument(
            "目标必须为调用方独占创建的空普通文件",
        ));
    }
    control.check()
}

impl SelectedEntry<'_> {
    pub fn copy_to(
        self,
        destination: &mut File,
        byte_limit: u64,
        control: &Control<'_>,
    ) -> Result<CopiedEntry> {
        control.check()?;
        let limit = byte_limit.min(MAX_FILE_BYTES);
        if self.entry.size > limit {
            return Err(Error::limit(LimitKind::FileBytes, limit));
        }
        empty_destination(destination, control)?;
        control.check()?;
        let index = self.archive.member_index(&self.entry.name)?;
        let fault = Fault::default();
        let mut reader = self.archive.reader(control, &fault);
        let mut source = fault.zip(reader.by_index(index))?;
        if source.size() != self.entry.size {
            return Err(Error::SourceChanged);
        }
        let mut total = 0u64;
        let mut buffer = [0; 65_536];
        loop {
            control.check()?;
            let length = source.read(&mut buffer).map_err(|e| fault.read_error(e))?;
            control.check()?;
            if length == 0 {
                break;
            }
            total = total
                .checked_add(length as u64)
                .ok_or(Error::limit(LimitKind::FileBytes, limit))?;
            if total > limit {
                return Err(Error::limit(LimitKind::FileBytes, limit));
            }
            if total > self.entry.size {
                return Err(Error::InvalidArchive("实际成员长度超过声明"));
            }
            control.check()?;
            destination
                .write_all(&buffer[..length])
                .map_err(|e| Error::io(IoStage::Write, e))?;
        }
        if total != self.entry.size {
            return Err(Error::InvalidArchive("成员未完整读取"));
        }
        control.check()?;
        destination
            .sync_all()
            .map_err(|e| Error::io(IoStage::Sync, e))?;
        control.check()?;
        Ok(CopiedEntry {
            name: self.entry.name,
            bytes: total,
        })
    }
}
