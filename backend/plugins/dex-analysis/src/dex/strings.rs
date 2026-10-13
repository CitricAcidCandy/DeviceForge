use super::{header::Header, word};
use crate::{Error, Result};
use deviceforge_android_package_core::Control;
use std::ops::Range;

pub(super) struct Strings {
    records: Vec<Range<usize>>,
}

fn byte(bytes: &[u8], position: &mut usize, end: usize) -> Result<u8> {
    if *position >= end {
        return Err(Error::Invalid("DEX字符串缺少结束字节"));
    }
    let value = bytes[*position];
    *position += 1;
    Ok(value)
}

fn continuation(bytes: &[u8], position: &mut usize, end: usize) -> Result<u16> {
    let value = byte(bytes, position, end)?;
    if value & 0xc0 != 0x80 {
        return Err(Error::Invalid("DEX MUTF-8续字节无效"));
    }
    Ok(u16::from(value & 0x3f))
}

fn decode(
    bytes: &[u8],
    start: usize,
    end: usize,
    control: &Control<'_>,
) -> Result<(Vec<u16>, usize)> {
    let mut position = start;
    let mut units = 0u32;
    for shift in [0, 7, 14, 21, 28] {
        let value = byte(bytes, &mut position, end)?;
        if shift == 28 && value & 0xf0 != 0 {
            return Err(Error::Invalid("DEX ULEB128长度超出32位"));
        }
        units |= u32::from(value & 0x7f) << shift;
        if value & 0x80 == 0 {
            break;
        }
    }
    if units > 65_536 {
        return Err(Error::TooLarge);
    }
    let body = position;
    let mut decoded = Vec::with_capacity(units as usize);
    loop {
        if decoded.len().is_multiple_of(256) {
            control.check()?;
        }
        if position - body > 196_608 {
            return Err(Error::TooLarge);
        }
        let first = byte(bytes, &mut position, end)?;
        let unit = match first {
            0 => break,
            1..=0x7f => u16::from(first),
            0xc0..=0xdf => {
                let second = continuation(bytes, &mut position, end)?;
                let value = (u16::from(first & 0x1f) << 6) | second;
                if value < 0x80 && !(first == 0xc0 && second == 0) {
                    return Err(Error::Invalid("DEX MUTF-8包含过长编码"));
                }
                value
            }
            0xe0..=0xef => {
                let second = continuation(bytes, &mut position, end)?;
                let third = continuation(bytes, &mut position, end)?;
                let value = (u16::from(first & 0x0f) << 12) | (second << 6) | third;
                if value < 0x800 {
                    return Err(Error::Invalid("DEX MUTF-8包含过长编码"));
                }
                value
            }
            _ => return Err(Error::Invalid("DEX MUTF-8不是合法的一至三码元编码")),
        };
        if decoded.len() >= units as usize {
            return Err(Error::Invalid("DEX字符串UTF-16声明长度不一致"));
        }
        decoded.push(unit);
    }
    if decoded.len() != units as usize {
        return Err(Error::Invalid("DEX字符串UTF-16声明长度不一致"));
    }
    control.check()?;
    Ok((decoded, position))
}

impl Strings {
    pub(super) fn parse(bytes: &[u8], header: &Header, control: &Control<'_>) -> Result<Self> {
        let table = header.tables[0];
        let mut records = Vec::with_capacity(table.count as usize);
        let mut previous: Option<Vec<u16>> = None;
        for index in 0..table.count as usize {
            control.check()?;
            let start = word(bytes, table.offset + index * table.width)? as usize;
            if !header.data.contains(&start) {
                return Err(Error::Invalid("DEX字符串不在数据区"));
            }
            header.region(0x2002, start, 1)?;
            let end = header.mapping[&0x2002].end;
            let (value, end) = decode(bytes, start, end, control)?;
            if previous.as_ref().is_some_and(|before| before >= &value) {
                return Err(Error::Invalid("DEX字符串索引未按UTF-16唯一排序"));
            }
            previous = Some(value);
            records.push(start..end);
        }
        let mut ordered = records.clone();
        ordered.sort_unstable_by_key(|range| range.start);
        if ordered.windows(2).any(|pair| pair[0].end > pair[1].start) {
            return Err(Error::Invalid("DEX字符串数据重叠"));
        }
        control.check()?;
        Ok(Self { records })
    }

    pub(super) fn get(&self, bytes: &[u8], index: u32, control: &Control<'_>) -> Result<String> {
        let range = self
            .records
            .get(index as usize)
            .ok_or(Error::Invalid("DEX字符串索引越界"))?;
        let (units, _) = decode(bytes, range.start, range.end, control)?;
        if units.len() > 4096 {
            return Err(Error::TooLarge);
        }
        String::from_utf16(&units).map_err(|_| Error::Invalid("DEX名称包含孤立代理码元"))
    }

    pub(super) fn contains(&self, index: u32) -> bool {
        (index as usize) < self.records.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutf8_preserves_encoded_nul_and_surrogate_pairs_with_utf16_counts() {
        let bytes = [4u8, b'a', 0xc0, 0x80, 0xed, 0xa0, 0x81, 0xed, 0xb0, 0x80, 0];
        let control = Control::new(None, &|| false);
        let (decoded, end) = decode(&bytes, 0, bytes.len(), &control).unwrap();
        assert_eq!(decoded, [0x0061, 0, 0xd801, 0xdc00]);
        assert_eq!(end, bytes.len());
    }

    #[test]
    fn isolated_surrogate_is_preserved_in_general_string_data() {
        let bytes = [1u8, 0xed, 0xa0, 0x80, 0];
        let control = Control::new(None, &|| false);
        assert_eq!(
            decode(&bytes, 0, bytes.len(), &control).unwrap().0,
            [0xd800]
        );
    }

    #[test]
    fn truncated_uleb128_and_mutf8_are_exact_failures() {
        let control = Control::new(None, &|| false);
        for bytes in [
            vec![0x80],
            vec![0xff, 0xff, 0xff, 0xff, 0x10, 0],
            vec![1, 0xc0],
            vec![1, 0xe0, 0x80, 0x80, 0],
            vec![1, 0xf0, 0x90, 0x80, 0x80, 0],
        ] {
            assert!(matches!(
                decode(&bytes, 0, bytes.len(), &control),
                Err(Error::Invalid(_))
            ));
        }
    }
}
