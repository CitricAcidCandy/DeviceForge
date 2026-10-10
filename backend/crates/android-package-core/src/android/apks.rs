use crate::{
    ApksSummary, BuildMode, Control, Error, LimitKind, Result,
    archive::{Archive, io_control::Fault},
    profiles::{MAX_APKS_EXPANDED_BYTES, MAX_FILE_BYTES},
};
use std::{collections::BTreeSet, io::Read};

pub fn validate_apks(
    archive: &mut Archive,
    mode: BuildMode,
    control: &Control<'_>,
) -> Result<ApksSummary> {
    control.check()?;
    if archive.file_size() > MAX_FILE_BYTES {
        return Err(Error::limit(LimitKind::ArchiveBytes, MAX_FILE_BYTES));
    }
    if archive.directory().declared_size() > MAX_APKS_EXPANDED_BYTES {
        return Err(Error::limit(
            LimitKind::ExpandedBytes,
            MAX_APKS_EXPANDED_BYTES,
        ));
    }
    let mut names = BTreeSet::new();
    for entry in archive.directory().entries() {
        control.check()?;
        if !names.insert(entry.name.as_str()) {
            return Err(Error::InvalidArchive("APKS 外层有重复成员"));
        }
    }
    let entries = archive.directory().entries().to_vec();
    let mut total = 0u64;
    let mut apk_count = 0;
    let mut toc = false;
    let mut universal_entry = None;
    for entry in entries {
        control.check()?;
        let index = archive.member_index(&entry.name)?;
        let fault = Fault::default();
        let mut reader = archive.reader(control, &fault);
        let mut source = fault.zip(reader.by_index(index))?;
        if source.size() != entry.size {
            return Err(Error::SourceChanged);
        }
        let mut count = 0u64;
        let mut magic = Vec::with_capacity(4);
        let mut buffer = [0; 65_536];
        loop {
            control.check()?;
            let length = source
                .read(&mut buffer)
                .map_err(|error| fault.read_error(error))?;
            control.check()?;
            if length == 0 {
                break;
            }
            count += length as u64;
            total = total.checked_add(length as u64).ok_or(Error::limit(
                LimitKind::ExpandedBytes,
                MAX_APKS_EXPANDED_BYTES,
            ))?;
            if total > MAX_APKS_EXPANDED_BYTES {
                return Err(Error::limit(
                    LimitKind::ExpandedBytes,
                    MAX_APKS_EXPANDED_BYTES,
                ));
            }
            if count > entry.size {
                return Err(Error::InvalidArchive("APKS 成员实际长度超过声明"));
            }
            let needed = 4usize.saturating_sub(magic.len()).min(length);
            magic.extend_from_slice(&buffer[..needed]);
        }
        if count != entry.size {
            return Err(Error::InvalidArchive("APKS 成员没有完整读取"));
        }
        if !entry.directory && entry.name == "toc.pb" {
            toc = count > 0;
        }
        if !entry.directory && entry.name.ends_with(".apk") {
            if magic != b"PK\x03\x04" {
                return Err(Error::InvalidArchive("APK 成员缺少 ZIP 标识"));
            }
            apk_count += 1;
            if entry.name == "universal.apk" {
                universal_entry = Some(entry.name);
            }
        }
    }
    if !toc || apk_count == 0 {
        return Err(Error::InvalidArchive("APKS 必须有非空 toc.pb 和 APK"));
    }
    if mode == BuildMode::Universal && (universal_entry.is_none() || apk_count != 1) {
        return Err(Error::InvalidArchive(
            "Universal 模式需要且仅能有 universal.apk",
        ));
    }
    control.check()?;
    Ok(ApksSummary {
        apk_count,
        universal_entry,
    })
}
