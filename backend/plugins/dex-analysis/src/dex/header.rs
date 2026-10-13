use super::{half, word};
use crate::{Error, Result, models::Counts};
use deviceforge_android_package_core::Control;
use std::{collections::BTreeMap, ops::Range};

#[derive(Clone, Copy)]
pub(super) struct Table {
    pub count: u32,
    pub offset: usize,
    pub width: usize,
}

pub(super) struct Header {
    pub version: &'static str,
    pub tables: [Table; 6],
    pub data: Range<usize>,
    pub mapping: BTreeMap<u16, Range<usize>>,
}

impl Header {
    pub(super) fn parse(bytes: &[u8], control: &Control<'_>) -> Result<Self> {
        if bytes.len() < 112 || bytes.get(..4) != Some(b"dex\n") || bytes[7] != 0 {
            return Err(Error::Invalid("缺少标准DEX头"));
        }
        let version = match &bytes[4..7] {
            b"035" => "035",
            b"037" => "037",
            b"038" => "038",
            b"039" => "039",
            b"040" => "040",
            _ => return Err(Error::Unsupported("只支持035/037/038/039/040的单一DEX")),
        };
        if word(bytes, 32)? as usize != bytes.len() || word(bytes, 36)? != 112 {
            return Err(Error::Invalid("DEX实际长度或112字节头不一致"));
        }
        if word(bytes, 40)? != 0x1234_5678 {
            return Err(Error::Unsupported("只支持little-endian"));
        }
        if word(bytes, 44)? != 0 || word(bytes, 48)? != 0 {
            return Err(Error::Unsupported("本阶段不支持链接区"));
        }
        let data_offset = word(bytes, 108)? as usize;
        let data_size = word(bytes, 104)? as usize;
        if data_offset < 112
            || !data_offset.is_multiple_of(4)
            || data_size == 0
            || data_offset.checked_add(data_size) != Some(bytes.len())
        {
            return Err(Error::Invalid("DEX数据区范围无效"));
        }
        let mut tables = [Table {
            count: 0,
            offset: 0,
            width: 0,
        }; 6];
        let mut ranges = Vec::new();
        for (index, width) in [4usize, 4, 12, 8, 8, 32].into_iter().enumerate() {
            control.check()?;
            let count = word(bytes, 56 + index * 8)?;
            let offset = word(bytes, 60 + index * 8)? as usize;
            let limit = if index == 0 { 1_000_000 } else { 65_535 };
            if count > limit {
                return Err(Error::TooLarge);
            }
            if count == 0 {
                if offset != 0 {
                    return Err(Error::Invalid("空DEX表仍有偏移"));
                }
            } else {
                let end = offset
                    .checked_add(count as usize * width)
                    .ok_or(Error::Invalid("DEX表范围溢出"))?;
                if offset < 112 || !offset.is_multiple_of(4) || end > data_offset {
                    return Err(Error::Invalid("DEX索引表越界或未对齐"));
                }
                ranges.push(offset..end);
            }
            tables[index] = Table {
                count,
                offset,
                width,
            };
        }
        ranges.sort_unstable_by_key(|range| range.start);
        if ranges.windows(2).any(|pair| pair[0].end > pair[1].start) {
            return Err(Error::Invalid("DEX索引表重叠"));
        }
        let map_offset = word(bytes, 52)? as usize;
        if map_offset < data_offset || !map_offset.is_multiple_of(4) {
            return Err(Error::Invalid("DEX映射表位置无效"));
        }
        let map_count = word(bytes, map_offset)? as usize;
        let map_end = map_offset
            .checked_add(4 + map_count.saturating_mul(12))
            .ok_or(Error::Invalid("DEX映射表范围溢出"))?;
        if map_count == 0 || map_count > 32 || map_end > bytes.len() {
            return Err(Error::Invalid("DEX映射表数量或范围无效"));
        }
        let mut entries = Vec::new();
        let mut kinds = BTreeMap::new();
        for index in 0..map_count {
            control.check()?;
            let position = map_offset + 4 + index * 12;
            let kind = half(bytes, position)?;
            let count = word(bytes, position + 4)?;
            let offset = word(bytes, position + 8)? as usize;
            let known = matches!(kind, 0..=8 | 0x1000..=0x1003 | 0x2000..=0x2006 | 0xf000);
            if !known
                || half(bytes, position + 2)? != 0
                || count == 0
                || kinds.insert(kind, (count, offset)).is_some()
                || offset >= bytes.len()
                || entries
                    .last()
                    .is_some_and(|&(_, previous)| previous >= offset)
            {
                return Err(Error::Invalid("DEX映射项未知、重复、无序或越界"));
            }
            if kind >= 0x1000 && offset < data_offset {
                return Err(Error::Invalid("DEX数据映射落在索引区"));
            }
            if ((kind == 7 || kind == 8) && version < "038") || (kind == 0xf000 && version < "039")
            {
                return Err(Error::Invalid("DEX映射项不属于声明版本"));
            }
            entries.push((kind, offset));
        }
        if kinds.get(&0) != Some(&(1, 0)) || kinds.get(&0x1000) != Some(&(1, map_offset)) {
            return Err(Error::Invalid("DEX映射缺少唯一头或自身"));
        }
        for (index, table) in tables.iter().enumerate() {
            let entry = kinds.get(&(index as u16 + 1));
            if (table.count == 0 && entry.is_some())
                || (table.count != 0 && entry != Some(&(table.count, table.offset)))
            {
                return Err(Error::Invalid("DEX头与索引映射不一致"));
            }
        }
        if (tables[0].count == 0 && kinds.contains_key(&0x2002))
            || (tables[0].count != 0
                && kinds.get(&0x2002).map(|entry| entry.0) != Some(tables[0].count))
        {
            return Err(Error::Invalid("DEX字符串数据映射数量不一致"));
        }
        let mut mapping = BTreeMap::new();
        for (index, &(kind, start)) in entries.iter().enumerate() {
            let end = entries.get(index + 1).map_or(bytes.len(), |entry| entry.1);
            let width = match kind {
                0 => 112,
                1 | 2 | 7 => 4,
                3 => 12,
                4 | 5 | 8 => 8,
                6 => 32,
                _ => 0,
            };
            let required = if kind == 0x1000 {
                map_end
            } else {
                start
                    .checked_add(
                        (kinds[&kind].0 as usize)
                            .checked_mul(width)
                            .ok_or(Error::Invalid("DEX映射跨度溢出"))?,
                    )
                    .ok_or(Error::Invalid("DEX映射跨度溢出"))?
            };
            if required > end || (width != 0 && !start.is_multiple_of(4)) {
                return Err(Error::Invalid("DEX映射区段重叠或未对齐"));
            }
            mapping.insert(kind, start..end);
        }
        Ok(Self {
            version,
            tables,
            data: data_offset..bytes.len(),
            mapping,
        })
    }

    pub(super) fn region(&self, kind: u16, offset: usize, size: usize) -> Result<()> {
        if self.mapping.get(&kind).is_none_or(|range| {
            offset < range.start || offset.checked_add(size).is_none_or(|end| end > range.end)
        }) {
            return Err(Error::Invalid("DEX数据引用不属于对应映射区段"));
        }
        Ok(())
    }

    pub(super) fn counts(&self) -> Counts {
        Counts {
            strings: self.tables[0].count,
            types: self.tables[1].count,
            prototypes: self.tables[2].count,
            fields: self.tables[3].count,
            methods: self.tables[4].count,
            defined_classes: self.tables[5].count,
        }
    }
}
