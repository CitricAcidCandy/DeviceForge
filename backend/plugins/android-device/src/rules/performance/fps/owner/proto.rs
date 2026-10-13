//! 只识别已核 AOSP 裸图层及带固定魔数的单快照文件。
use super::super::super::Check;
use super::{
    Record,
    wire::{self, Budget, Cursor, Value},
};
use crate::{Error, Result};
const MAGIC: &[u8] = b"LYRTRACE";
fn bad() -> Error {
    Error::Dependency(wire::BAD)
}

fn metadata(data: &[u8], budget: &mut Budget, check: Check<'_>) -> Result<(i32, Vec<u8>)> {
    let mut cursor = Cursor::new(data);
    let mut key = None;
    let mut value = None;
    while let Some(field) = cursor.next(budget, check)? {
        match field.number {
            1 => wire::once(&mut key, wire::signed(wire::integer(field.value)?)?)?,
            2 => {
                let bytes = wire::bytes(field.value)?;
                if bytes.len() > 4096 {
                    return Err(Error::TooLarge);
                }
                wire::once(&mut value, bytes.to_vec())?;
            }
            _ => return Err(bad()),
        }
    }
    Ok((key.ok_or_else(bad)?, value.ok_or_else(bad)?))
}
fn record(data: &[u8], budget: &mut Budget, check: Check<'_>) -> Result<Record> {
    let mut cursor = Cursor::new(data);
    let (mut id, mut name, mut parent, mut uid) = (None, None, None, None);
    let (mut metadata_uid, mut metadata_pid) = (None, None);
    let mut keys = std::collections::BTreeSet::new();
    while let Some(field) = cursor.next(budget, check)? {
        match field.number {
            1 => wire::once(&mut id, wire::signed(wire::integer(field.value)?)?)?,
            2 => {
                let value = wire::bytes(field.value)?;
                if value.len() > 1024 {
                    return Err(Error::TooLarge);
                }
                let value = std::str::from_utf8(value).map_err(|_| bad())?;
                if value.is_empty()
                    || value.chars().any(char::is_control)
                    || value.contains('\u{fffd}')
                {
                    return Err(bad());
                }
                wire::once(&mut name, value.to_owned())?;
            }
            25 => wire::once(&mut parent, wire::signed(wire::integer(field.value)?)?)?,
            53 => wire::once(
                &mut uid,
                u32::try_from(wire::integer(field.value)?).map_err(|_| bad())?,
            )?,
            42 => {
                if keys.len() >= 64 {
                    return Err(Error::TooLarge);
                }
                let (key, value) = metadata(wire::bytes(field.value)?, budget, check)?;
                if !keys.insert(key) {
                    return Err(bad());
                }
                if matches!(key, 1 | 6) {
                    let value = i32::from_le_bytes(value.as_slice().try_into().map_err(|_| bad())?);
                    let value = u32::try_from(value).map_err(|_| bad())?;
                    if key == 1 {
                        metadata_uid = Some(value);
                    } else {
                        metadata_pid = Some(value);
                    }
                }
            }
            _ => (),
        }
    }
    let id = id.ok_or_else(bad)?;
    let parent = parent.unwrap_or(0);
    if id < 0 || parent < -1 {
        return Err(bad());
    }
    Ok(Record {
        id,
        name: name.ok_or_else(bad)?,
        parent,
        uid,
        metadata_uid,
        metadata_pid,
    })
}
fn layers(data: &[u8], budget: &mut Budget, check: Check<'_>) -> Result<Vec<Record>> {
    let mut cursor = Cursor::new(data);
    let mut records = Vec::new();
    let mut ids = std::collections::BTreeSet::new();
    while let Some(field) = cursor.next(budget, check)? {
        if field.number != 1 {
            return Err(bad());
        }
        if records.len() >= 4096 {
            return Err(Error::TooLarge);
        }
        let record = record(wire::bytes(field.value)?, budget, check)?;
        if !ids.insert(record.id) {
            return Err(bad());
        }
        records.push(record);
    }
    Ok(records)
}
fn snapshot<'a>(data: &'a [u8], budget: &mut Budget, check: Check<'_>) -> Result<&'a [u8]> {
    let mut cursor = Cursor::new(data);
    let mut layers = None;
    while let Some(field) = cursor.next(budget, check)? {
        if field.number == 3 {
            wire::once(&mut layers, wire::bytes(field.value)?)?;
        }
    }
    layers.ok_or_else(bad)
}
pub(super) fn parse(data: &[u8], check: Check<'_>) -> Result<Vec<Record>> {
    check()?;
    if data.len() > 1024 * 1024 {
        return Err(Error::TooLarge);
    }
    let mut budget = Budget::new();
    match data.first() {
        Some(0x0a) => layers(data, &mut budget, check),
        Some(0x09) => {
            let mut cursor = Cursor::new(data);
            let first = cursor.next(&mut budget, check)?.ok_or_else(bad)?;
            if !matches!(first.value, Value::Fixed64(value) if value == MAGIC) {
                return Err(bad());
            }
            let mut entry = None;
            let mut offset = false;
            while let Some(field) = cursor.next(&mut budget, check)? {
                match field.number {
                    1 => return Err(bad()),
                    2 => wire::once(&mut entry, wire::bytes(field.value)?)?,
                    3 if matches!(field.value, Value::Fixed64(_)) && !offset => offset = true,
                    _ => return Err(bad()),
                }
            }
            let data = snapshot(entry.ok_or_else(bad)?, &mut budget, check)?;
            layers(data, &mut budget, check)
        }
        _ => Err(bad()),
    }
}
