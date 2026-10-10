use super::{
    Archive,
    copy::empty_destination,
    io_control::Fault,
    tree::{self, TreeSnapshot},
};
use crate::{
    ArchiveProfile, Control, Error, IoStage, LimitKind, PackedTree, Result, TreeProfile,
    profiles::MAX_FILE_BYTES,
};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
};

struct BoundedOutput<'a, 'c> {
    file: &'a mut File,
    control: &'a Control<'c>,
    failure: &'a Fault,
    position: u64,
    extent: u64,
}

impl BoundedOutput<'_, '_> {
    fn fail(&self, error: Error) -> io::Error {
        self.failure.fail(error)
    }
    fn check(&self) -> io::Result<()> {
        self.failure.check(self.control)
    }
}

impl Write for BoundedOutput<'_, '_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.check()?;
        self.position
            .checked_add(bytes.len() as u64)
            .filter(|end| *end <= MAX_FILE_BYTES)
            .ok_or_else(|| self.fail(Error::limit(LimitKind::ArchiveBytes, MAX_FILE_BYTES)))?;
        let written = self
            .file
            .write(bytes)
            .map_err(|e| self.fail(Error::io(IoStage::Write, e)))?;
        self.position += written as u64;
        self.extent = self.extent.max(self.position);
        self.check()?;
        Ok(written)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.check()?;
        self.file
            .flush()
            .map_err(|e| self.fail(Error::io(IoStage::Write, e)))?;
        self.check()
    }
}

impl Seek for BoundedOutput<'_, '_> {
    fn seek(&mut self, offset: SeekFrom) -> io::Result<u64> {
        self.check()?;
        let target = match offset {
            SeekFrom::Start(position) => Some(position),
            SeekFrom::Current(delta) => self.position.checked_add_signed(delta),
            SeekFrom::End(delta) => self.extent.checked_add_signed(delta),
        }
        .filter(|position| *position <= MAX_FILE_BYTES)
        .ok_or_else(|| self.fail(Error::limit(LimitKind::ArchiveBytes, MAX_FILE_BYTES)))?;
        self.position = self
            .file
            .seek(SeekFrom::Start(target))
            .map_err(|e| self.fail(Error::io(IoStage::Seek, e)))?;
        self.check()?;
        Ok(self.position)
    }
}

fn zip_result<T>(value: zip::result::ZipResult<T>, failure: &Fault) -> Result<T> {
    value.map_err(|error| {
        failure.stop();
        failure.take().unwrap_or_else(|| match error {
            zip::result::ZipError::Io(error) => Error::io(IoStage::Write, error),
            _ => Error::InvalidArchive("Stored ZIP 写入失败"),
        })
    })
}

fn validate_final(snapshot: &TreeSnapshot, control: &Control<'_>) -> Result<()> {
    control.check()?;
    let current = tree::scan(&snapshot.root, snapshot.profile, control)?;
    if current.directory.entries != snapshot.directory.entries {
        return Err(Error::SourceChanged);
    }
    match snapshot.profile {
        TreeProfile::Reverse => crate::android::validate_decoded(&snapshot.directory)?,
        TreeProfile::Splits => {
            let files: Vec<_> = snapshot
                .directory
                .entries
                .iter()
                .filter(|entry| !entry.directory)
                .collect();
            if files.is_empty() || files.iter().any(|entry| !entry.name.ends_with(".apk")) {
                return Err(Error::InvalidArchive(
                    "Splits 最终目录必须包含且仅包含 APK 文件",
                ));
            }
            for entry in files {
                control.check()?;
                let path = snapshot.root.join(&entry.name);
                tree::checked_metadata(&path, control)?;
                control.check()?;
                let file = File::open(path).map_err(|e| Error::io(IoStage::Open, e))?;
                Archive::open(file, ArchiveProfile::Structure, control)?;
            }
        }
    }
    control.check()
}

pub(super) fn pack(
    snapshot: &TreeSnapshot,
    destination: &mut File,
    control: &Control<'_>,
) -> Result<PackedTree> {
    control.check()?;
    validate_final(snapshot, control)?;
    empty_destination(destination, control)?;
    let failure = Fault::default();
    let output = BoundedOutput {
        file: destination,
        control,
        failure: &failure,
        position: 0,
        extent: 0,
    };
    let mut writer = zip::ZipWriter::new(output);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o644);
    let copied = (|| {
        let mut names = Vec::new();
        for entry in snapshot
            .directory
            .entries
            .iter()
            .filter(|entry| !entry.directory)
        {
            control.check()?;
            let path = snapshot.root.join(&entry.name);
            let metadata = tree::checked_metadata(&path, control)?;
            if !metadata.is_file() || metadata.len() != entry.size {
                return Err(Error::SourceChanged);
            }
            control.check()?;
            let mut file = File::open(&path).map_err(|e| Error::io(IoStage::Open, e))?;
            control.check()?;
            let metadata = file
                .metadata()
                .map_err(|e| Error::io(IoStage::Metadata, e))?;
            if !metadata.is_file() || metadata.len() != entry.size {
                return Err(Error::SourceChanged);
            }
            zip_result(writer.start_file(&entry.name, options), &failure)?;
            copy_source(&mut file, &mut writer, entry.size, control, &failure)?;
            let metadata = tree::checked_metadata(&path, control)?;
            if !metadata.is_file() || metadata.len() != entry.size {
                return Err(Error::SourceChanged);
            }
            names.push(entry.name.clone());
        }
        control.check()?;
        Ok(names)
    })();
    let names = match copied {
        Ok(names) => names,
        Err(error) => {
            // ZIP writer 的 Drop 也可能尝试收尾；先封住底层，错误后不再写头部/目录。
            failure.stop();
            drop(writer);
            return Err(error);
        }
    };
    let extent = zip_result(writer.finish(), &failure)?.extent;
    control.check()?;
    destination
        .sync_all()
        .map_err(|e| Error::io(IoStage::Sync, e))?;
    control.check()?;
    let size = destination
        .metadata()
        .map_err(|e| Error::io(IoStage::Metadata, e))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err(Error::limit(LimitKind::ArchiveBytes, MAX_FILE_BYTES));
    }
    if size != extent {
        return Err(Error::SourceChanged);
    }
    let current = tree::scan(&snapshot.root, snapshot.profile, control)?;
    if current.directory.entries != snapshot.directory.entries {
        return Err(Error::SourceChanged);
    }
    control.check()?;
    Ok(PackedTree {
        files: names.len(),
        unpacked_size: snapshot.directory.declared_size,
        archive_size: size,
        entries: names,
    })
}

fn copy_source<W: Write + Seek>(
    source: &mut File,
    writer: &mut zip::ZipWriter<W>,
    expected: u64,
    control: &Control<'_>,
    failure: &Fault,
) -> Result<()> {
    let mut buffer = [0; 65_536];
    let mut total = 0u64;
    loop {
        control.check()?;
        let count = source
            .read(&mut buffer)
            .map_err(|e| Error::io(IoStage::Read, e))?;
        control.check()?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > expected {
            return Err(Error::SourceChanged);
        }
        writer.write_all(&buffer[..count]).map_err(|e| {
            failure
                .take()
                .unwrap_or_else(|| Error::io(IoStage::Write, e))
        })?;
    }
    if total != expected {
        return Err(Error::SourceChanged);
    }
    control.check()
}
