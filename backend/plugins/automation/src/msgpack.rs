//! InputTrace连续MessagePack记录的严格有界扫描与事件过滤。
use crate::{Error, Result};
const MAX_EVENTS: usize = 100_000;
struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}
impl<'a> Parser<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }
    fn byte(&mut self) -> Result<u8> {
        let b = *self
            .bytes
            .get(self.pos)
            .ok_or(Error::Invalid("录制产物尾部截断"))?;
        self.pos += 1;
        Ok(b)
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(n).ok_or(Error::TooLarge)?;
        let out = self
            .bytes
            .get(self.pos..end)
            .ok_or(Error::Invalid("录制产物尾部截断"))?;
        self.pos = end;
        Ok(out)
    }
    fn uint(&mut self, code: u8) -> Result<u64> {
        match code {
            0x00..=0x7f => Ok(u64::from(code)),
            0xcc => Ok(u64::from(self.byte()?)),
            0xcd => Ok(u64::from(u16::from_be_bytes(
                self.take(2)?.try_into().unwrap(),
            ))),
            0xce => Ok(u64::from(u32::from_be_bytes(
                self.take(4)?.try_into().unwrap(),
            ))),
            0xcf => Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap())),
            _ => Err(Error::Invalid("录制产物整数类型无效")),
        }
    }
    fn int(&mut self) -> Result<i128> {
        let c = self.byte()?;
        match c {
            0xe0..=0xff => Ok(i128::from(i8::from_be_bytes([c]))),
            0xd0 => Ok(i128::from(i8::from_be_bytes([self.byte()?]))),
            0xd1 => Ok(i128::from(i16::from_be_bytes(
                self.take(2)?.try_into().unwrap(),
            ))),
            0xd2 => Ok(i128::from(i32::from_be_bytes(
                self.take(4)?.try_into().unwrap(),
            ))),
            0xd3 => Ok(i128::from(i64::from_be_bytes(
                self.take(8)?.try_into().unwrap(),
            ))),
            0x00..=0x7f | 0xcc..=0xcf => Ok(i128::from(self.uint(c)?)),
            _ => Err(Error::Invalid("录制产物事件类型无效")),
        }
    }
    fn array(&mut self) -> Result<usize> {
        let c = self.byte()?;
        match c {
            0x90..=0x9f => Ok(usize::from(c & 0x0f)),
            0xdc => Ok(usize::from(u16::from_be_bytes(
                self.take(2)?.try_into().unwrap(),
            ))),
            0xdd => {
                let n = u32::from_be_bytes(self.take(4)?.try_into().unwrap());
                usize::try_from(n).map_err(|_| Error::TooLarge)
            }
            _ => Err(Error::Invalid("录制产物数组类型无效")),
        }
    }
    fn string(&mut self) -> Result<usize> {
        let c = self.byte()?;
        let n = match c {
            0xa0..=0xbf => usize::from(c & 0x1f),
            0xd9 => usize::from(self.byte()?),
            0xda => usize::from(u16::from_be_bytes(self.take(2)?.try_into().unwrap())),
            0xdb => usize::try_from(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
                .map_err(|_| Error::TooLarge)?,
            _ => return Err(Error::Invalid("录制产物字符串类型无效")),
        };
        self.take(n)?;
        Ok(n)
    }
    fn value(&mut self, depth: usize) -> Result<()> {
        if depth > 4 {
            return Err(Error::Invalid("录制产物嵌套过深"));
        }
        let c = *self
            .bytes
            .get(self.pos)
            .ok_or(Error::Invalid("录制产物尾部截断"))?;
        if c <= 0x7f || c >= 0xe0 || c == 0xc0 || c == 0xc2 || c == 0xc3 {
            self.pos += 1;
            return Ok(());
        }
        if c & 0xe0 == 0xa0 {
            self.string()?;
            return Ok(());
        }
        if c & 0xf0 == 0x90 {
            let n = self.array()?;
            if n > 9 {
                return Err(Error::TooLarge);
            }
            for _ in 0..n {
                self.value(depth + 1)?
            }
            return Ok(());
        }
        match c {
            0xcc..=0xd3 => {
                self.pos += 1;
                self.take(match c {
                    0xcc => 1,
                    0xcd => 2,
                    0xce => 4,
                    0xcf => 8,
                    0xd0 => 1,
                    0xd1 => 2,
                    0xd2 => 4,
                    _ => 8,
                })?;
                Ok(())
            }
            0xd9..=0xdb => {
                self.string()?;
                Ok(())
            }
            0xdc | 0xdd => {
                let n = self.array()?;
                if n > 9 {
                    return Err(Error::TooLarge);
                }
                for _ in 0..n {
                    self.value(depth + 1)?
                }
                Ok(())
            }
            0xc4 => {
                self.pos += 1;
                let n = usize::from(self.byte()?);
                self.take(n)?;
                Ok(())
            }
            0xc5 => {
                self.pos += 1;
                let n = usize::from(u16::from_be_bytes(self.take(2)?.try_into().unwrap()));
                self.take(n)?;
                Ok(())
            }
            0xc6 => {
                self.pos += 1;
                let n = usize::try_from(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
                    .map_err(|_| Error::TooLarge)?;
                self.take(n)?;
                Ok(())
            }
            _ => Err(Error::Invalid("录制产物值类型不支持")),
        }
    }
    fn record(&mut self) -> Result<(u8, u64)> {
        let n = self.array()?;
        if n != 10 {
            return Err(Error::Invalid("录制产物记录字段数无效"));
        }
        if self.string()? > 128 {
            return Err(Error::Invalid("录制产物标识过长"));
        }
        let typ = i128_to_u8(self.int()?)?;
        let time = i128_to_u64(self.int()?)?;
        self.value(0)?;
        self.value(0)?;
        self.value(0)?;
        self.optional_array(4)?;
        self.optional_array(3)?;
        self.optional_int()?;
        let c = self.byte()?;
        if c != 0xc2 && c != 0xc3 {
            return Err(Error::Invalid("录制产物结束标记无效"));
        }
        Ok((typ, time))
    }
    fn optional_array(&mut self, expected: usize) -> Result<()> {
        let c = *self
            .bytes
            .get(self.pos)
            .ok_or(Error::Invalid("录制产物尾部截断"))?;
        if c == 0xc0 {
            self.pos += 1;
            return Ok(());
        }
        let n = self.array()?;
        if n != expected {
            return Err(Error::Invalid("录制产物嵌套字段数无效"));
        }
        for _ in 0..n {
            self.value(0)?
        }
        Ok(())
    }
    fn optional_int(&mut self) -> Result<()> {
        if self.bytes.get(self.pos) == Some(&0xc0) {
            self.pos += 1;
            Ok(())
        } else {
            self.int().map(|_| ())
        }
    }
}
fn i128_to_u8(v: i128) -> Result<u8> {
    u8::try_from(v).map_err(|_| Error::Invalid("录制产物事件类型无效"))
}
fn i128_to_u64(v: i128) -> Result<u64> {
    u64::try_from(v).map_err(|_| Error::Invalid("录制产物时间无效"))
}
pub(crate) fn scan(data: &[u8], event_type: u8) -> Result<(Vec<u8>, u64)> {
    if data.is_empty() || data.len() > 64 * 1024 * 1024 {
        return Err(Error::TooLarge);
    }
    if event_type > 2 {
        return Err(Error::Invalid("录制事件筛选类型无效"));
    }
    let mut parser = Parser::new(data);
    let mut output = Vec::new();
    let mut matched = 0_u64;
    let mut total = 0_usize;
    let mut previous = None;
    let mut origin = None;
    while parser.pos < data.len() {
        let start = parser.pos;
        let (kind, time) = parser.record()?;
        total += 1;
        if total > MAX_EVENTS {
            return Err(Error::TooLarge);
        }
        if !(3..=11).contains(&kind) {
            return Err(Error::Invalid("录制产物事件类型无效"));
        }
        let first = *origin.get_or_insert(time);
        if previous.is_some_and(|last| time < last) || time.saturating_sub(first) > 600_000 {
            return Err(Error::Invalid("录制产物时间倒退或总播放时长超限"));
        }
        previous = Some(time);
        if event_type == 0
            || (event_type == 1 && (3..=5).contains(&kind))
            || (event_type == 2 && (6..=11).contains(&kind))
        {
            output.extend_from_slice(&data[start..parser.pos]);
            matched += 1;
        }
    }
    if output.is_empty() {
        return Err(Error::Invalid("录制产物没有匹配事件"));
    }
    Ok((output, matched))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(kind: u8, time: u32) -> Vec<u8> {
        let mut bytes = vec![0x9a, 0xa1, b'x', kind, 0xce];
        bytes.extend(time.to_be_bytes());
        bytes.extend([0xc0, 0xc0, 0xc0, 0xc0, 0xc0, 0xc0, 0xc2]);
        bytes
    }
    #[test]
    fn continuous_records_filter_without_changing_selected_bytes() {
        let keyboard = record(3, 0);
        let mouse = record(6, 100);
        let mut data = keyboard.clone();
        data.extend(mouse.clone());
        assert_eq!(scan(&data, 0).unwrap(), (data.clone(), 2));
        assert_eq!(scan(&data, 1).unwrap(), (keyboard, 1));
        assert_eq!(scan(&data, 2).unwrap(), (mouse, 1));
        assert!(scan(&data[..data.len() - 1], 0).is_err());
    }
    #[test]
    fn rejects_total_duration_reverse_time_unknown_kind_and_filtered_overflow() {
        let mut long = record(3, 0);
        long.extend(record(3, 400_000));
        long.extend(record(3, 800_000));
        assert!(scan(&long, 0).is_err());
        let mut reverse = record(3, 10);
        reverse.extend(record(3, 9));
        assert!(scan(&reverse, 0).is_err());
        assert!(scan(&record(12, 0), 0).is_err());
        let mut overflow = record(3, 0).repeat(MAX_EVENTS);
        overflow.extend(record(6, 0));
        assert!(matches!(scan(&overflow, 2), Err(Error::TooLarge)));
    }
}
