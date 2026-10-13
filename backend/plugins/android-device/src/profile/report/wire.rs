//! protobuf wire只作固定协议扫描；不猜格式、不递归解析未知字段。
use crate::{Error, Result};
pub(super) enum Value<'a> {
    Number(u64),
    Bytes(&'a [u8]),
    Fixed,
}
pub(super) struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }
    fn varint(&mut self) -> Result<u64> {
        let mut value = 0u64;
        for shift in (0..70).step_by(7) {
            let byte = *self
                .bytes
                .get(self.offset)
                .ok_or(Error::Dependency("堆栈protobuf整数不完整"))?;
            self.offset += 1;
            if shift == 63 && byte > 1 {
                return Err(Error::Dependency("堆栈protobuf整数溢出"));
            }
            value |= u64::from(byte & 127) << shift;
            if byte & 128 == 0 {
                return Ok(value);
            }
        }
        Err(Error::Dependency("堆栈protobuf整数无终止"))
    }
    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(count)
            .filter(|end| *end <= self.bytes.len())
            .ok_or(Error::Dependency("堆栈protobuf字段越界"))?;
        let value = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(value)
    }
    pub fn next(&mut self) -> Result<Option<(u32, Value<'a>)>> {
        if self.offset == self.bytes.len() {
            return Ok(None);
        }
        let key = self.varint()?;
        let field = u32::try_from(key >> 3)
            .ok()
            .filter(|v| (1..=0x1fff_ffff).contains(v))
            .ok_or(Error::Dependency("堆栈protobuf字段编号无效"))?;
        let value = match key & 7 {
            0 => Value::Number(self.varint()?),
            1 => {
                self.take(8)?;
                Value::Fixed
            }
            2 => {
                let size = usize::try_from(self.varint()?).map_err(|_| Error::TooLarge)?;
                Value::Bytes(self.take(size)?)
            }
            5 => {
                self.take(4)?;
                Value::Fixed
            }
            _ => return Err(Error::Dependency("堆栈protobuf字段类型不支持")),
        };
        Ok(Some((field, value)))
    }
}
pub(super) fn number(value: Value<'_>) -> Result<u64> {
    match value {
        Value::Number(v) => Ok(v),
        _ => Err(Error::Dependency("堆栈protobuf整数类型不符")),
    }
}
pub(super) fn bytes(value: Value<'_>) -> Result<&[u8]> {
    match value {
        Value::Bytes(v) => Ok(v),
        _ => Err(Error::Dependency("堆栈protobuf子消息类型不符")),
    }
}
pub(super) fn u32_value(value: Value<'_>) -> Result<u32> {
    u32::try_from(number(value)?).map_err(|_| Error::Dependency("堆栈protobuf编号溢出"))
}
pub(super) fn text(value: Value<'_>) -> Result<String> {
    let value = bytes(value)?;
    if value.len() > 2048 {
        return Err(Error::TooLarge);
    }
    let s = std::str::from_utf8(value).map_err(|_| Error::Dependency("堆栈报告文本不是UTF-8"))?;
    if s.chars().any(|c| c == '\0') {
        return Err(Error::Dependency("堆栈报告文本含空字符"));
    }
    Ok(s.to_owned())
}
pub(super) fn singular<T>(slot: &mut Option<T>, value: T) -> Result<()> {
    if slot.replace(value).is_some() {
        Err(Error::Dependency("堆栈报告单值字段重复"))
    } else {
        Ok(())
    }
}
