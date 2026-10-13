mod classes;
mod header;
mod integrity;
mod strings;
mod tables;

use crate::{Result, models::Analysis};
use deviceforge_android_package_core::Control;

pub(crate) fn parse(bytes: &[u8], control: &Control<'_>) -> Result<Analysis> {
    control.check()?;
    if bytes.len() as u64 > crate::input::FILE_LIMIT {
        return Err(crate::Error::TooLarge);
    }
    let header = header::Header::parse(bytes, control)?;
    integrity::verify(bytes, control)?;
    let strings = strings::Strings::parse(bytes, &header, control)?;
    let types = tables::types(bytes, &header, &strings, control)?;
    tables::members(bytes, &header, &strings, &types, control)?;
    let classes = classes::parse(bytes, &header, &strings, &types, control)?;
    control.check()?;
    Ok(Analysis {
        version: header.version.to_string(),
        file_size: bytes.len(),
        counts: header.counts(),
        classes,
    })
}

pub(super) fn word(bytes: &[u8], offset: usize) -> Result<u32> {
    let end = offset
        .checked_add(4)
        .ok_or(crate::Error::Invalid("DEX整数偏移溢出"))?;
    Ok(u32::from_le_bytes(
        bytes
            .get(offset..end)
            .ok_or(crate::Error::Invalid("DEX整数超出字节范围"))?
            .try_into()
            .unwrap(),
    ))
}

pub(super) fn half(bytes: &[u8], offset: usize) -> Result<u16> {
    let end = offset
        .checked_add(2)
        .ok_or(crate::Error::Invalid("DEX短整数偏移溢出"))?;
    Ok(u16::from_le_bytes(
        bytes
            .get(offset..end)
            .ok_or(crate::Error::Invalid("DEX短整数超出字节范围"))?
            .try_into()
            .unwrap(),
    ))
}
