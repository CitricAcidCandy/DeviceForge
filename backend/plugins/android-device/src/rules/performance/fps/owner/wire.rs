//! SurfaceFlinger protobuf 的有限线格式读取，不生成递归消息或任意长度缓冲。
use super::super::super::Check;
use crate::{Error, Result};

pub(super) const BAD: &str = "SurfaceFlinger归属格式不可用";
const MAX_FIELDS: usize = 65536;
pub(super) struct Budget { fields: usize }
impl Budget { pub(super) fn new() -> Self { Self { fields: 0 } } }
pub(super) enum Value<'a> { Integer(u64), Bytes(&'a [u8]), Fixed64(&'a [u8]), Fixed32 }
pub(super) struct Field<'a> { pub number: u32, pub value: Value<'a> }
pub(super) struct Cursor<'a> { bytes: &'a [u8], position: usize }
impl<'a> Cursor<'a> {
    pub(super) fn new(bytes: &'a [u8]) -> Self { Self { bytes, position: 0 } }
    fn varint(&mut self) -> Result<u64> {
        let mut result = 0;
        for index in 0..10 {
            let byte = *self.bytes.get(self.position).ok_or(Error::Dependency(BAD))?;
            self.position += 1;
            if index == 9 && byte > 1 { return Err(Error::Dependency(BAD)); }
            result |= u64::from(byte & 0x7f) << (index * 7);
            if byte < 0x80 {
                if index > 0 && byte == 0 { return Err(Error::Dependency(BAD)); }
                return Ok(result);
            }
        }
        Err(Error::Dependency(BAD))
    }
    fn take(&mut self, length: usize) -> Result<&'a [u8]> {
        let end = self.position.checked_add(length).ok_or(Error::Dependency(BAD))?;
        let bytes = self.bytes.get(self.position..end).ok_or(Error::Dependency(BAD))?;
        self.position = end;
        Ok(bytes)
    }
    pub(super) fn next(&mut self, budget: &mut Budget, check: Check<'_>) -> Result<Option<Field<'a>>> {
        check()?;
        if self.position == self.bytes.len() { return Ok(None); }
        budget.fields += 1;
        if budget.fields > MAX_FIELDS { return Err(Error::TooLarge); }
        let tag = self.varint()?;
        let number = u32::try_from(tag >> 3).map_err(|_| Error::Dependency(BAD))?;
        if number == 0 || number > 0x1fff_ffff { return Err(Error::Dependency(BAD)); }
        let value = match tag & 7 {
            0 => Value::Integer(self.varint()?),
            1 => Value::Fixed64(self.take(8)?),
            2 => {
                let length = usize::try_from(self.varint()?).map_err(|_| Error::Dependency(BAD))?;
                Value::Bytes(self.take(length)?)
            }
            5 => { self.take(4)?; Value::Fixed32 }
            _ => return Err(Error::Dependency(BAD)),
        };
        Ok(Some(Field { number, value }))
    }
}
pub(super) fn integer(value: Value<'_>) -> Result<u64> {
    match value { Value::Integer(value) => Ok(value), _ => Err(Error::Dependency(BAD)) }
}
pub(super) fn bytes<'a>(value: Value<'a>) -> Result<&'a [u8]> {
    match value { Value::Bytes(value) => Ok(value), _ => Err(Error::Dependency(BAD)) }
}
pub(super) fn signed(value: u64) -> Result<i32> {
    let signed = value as i64;
    i32::try_from(signed).map_err(|_| Error::Dependency(BAD))
}
pub(super) fn once<T>(target: &mut Option<T>, value: T) -> Result<()> {
    if target.replace(value).is_some() { return Err(Error::Dependency(BAD)); }
    Ok(())
}
