use super::{half, header::Header, strings::Strings, word};
use crate::{Error, Result};
use deviceforge_android_package_core::Control;

pub(super) fn simple(name: &str, version: &str) -> bool {
    !name.is_empty() && name.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '$' | '-' | '_')
            || matches!(character as u32, 0x00a1..=0x1fff | 0x2010..=0x2027 | 0x2030..=0xd7ff | 0xe000..=0xffef | 0x10000..=0x10ffff)
            || (version == "040" && matches!(character as u32, 0x20 | 0xa0 | 0x2000..=0x200a | 0x202f))
    })
}

fn descriptor(value: &str, version: &str) -> bool {
    let depth = value.bytes().take_while(|byte| *byte == b'[').count();
    if depth > 255 {
        return false;
    }
    let base = &value[depth..];
    if base.len() == 1 && b"VZBSCIJFD".contains(&base.as_bytes()[0]) {
        return depth == 0 || base != "V";
    }
    base.strip_prefix('L')
        .and_then(|name| name.strip_suffix(';'))
        .is_some_and(|name| name.split('/').all(|part| simple(part, version)))
}

pub(super) fn types(
    bytes: &[u8],
    header: &Header,
    strings: &Strings,
    control: &Control<'_>,
) -> Result<Vec<String>> {
    let table = header.tables[1];
    let mut types = Vec::with_capacity(table.count as usize);
    let mut previous = None;
    let mut size = 0usize;
    for index in 0..table.count as usize {
        control.check()?;
        let descriptor_index = word(bytes, table.offset + index * table.width)?;
        if previous.is_some_and(|before| before >= descriptor_index) {
            return Err(Error::Invalid("DEX类型索引未唯一排序"));
        }
        let value = strings.get(bytes, descriptor_index, control)?;
        if !descriptor(&value, header.version) {
            return Err(Error::Invalid("DEX类型描述符无效"));
        }
        size += value.len();
        if size > 16 * 1024 * 1024 {
            return Err(Error::TooLarge);
        }
        types.push(value);
        previous = Some(descriptor_index);
    }
    Ok(types)
}

pub(super) fn kind(types: &[String], index: u32) -> Result<&str> {
    types
        .get(index as usize)
        .map(String::as_str)
        .ok_or(Error::Invalid("DEX类型引用越界"))
}

pub(super) fn class(types: &[String], index: u32) -> Result<&str> {
    let value = kind(types, index)?;
    if !value.starts_with('L') {
        return Err(Error::Invalid("DEX类引用不是对象描述符"));
    }
    Ok(value)
}

pub(super) fn parameters(
    bytes: &[u8],
    header: &Header,
    offset: usize,
    control: &Control<'_>,
) -> Result<Vec<u16>> {
    if offset == 0 {
        return Ok(Vec::new());
    }
    if !offset.is_multiple_of(4) {
        return Err(Error::Invalid("DEX类型列表未对齐"));
    }
    header.region(0x1001, offset, 4)?;
    let count = word(bytes, offset)? as usize;
    if count > 65_535 {
        return Err(Error::TooLarge);
    }
    header.region(0x1001, offset, 4 + count * 2)?;
    let mut result = Vec::with_capacity(count);
    for index in 0..count {
        control.check()?;
        result.push(half(bytes, offset + 4 + index * 2)?);
    }
    Ok(result)
}

fn short(value: &str) -> u8 {
    if value.starts_with(['L', '[']) {
        b'L'
    } else {
        value.as_bytes()[0]
    }
}

fn prototypes(
    bytes: &[u8],
    header: &Header,
    strings: &Strings,
    types: &[String],
    control: &Control<'_>,
) -> Result<()> {
    let table = header.tables[2];
    let mut previous = None;
    for index in 0..table.count as usize {
        control.check()?;
        let position = table.offset + index * table.width;
        let shorty = strings.get(bytes, word(bytes, position)?, control)?;
        let returns = word(bytes, position + 4)?;
        let args = parameters(bytes, header, word(bytes, position + 8)? as usize, control)?;
        let mut expected = vec![short(kind(types, returns)?)];
        for &argument in &args {
            let value = kind(types, u32::from(argument))?;
            if value == "V" {
                return Err(Error::Invalid("DEX参数类型不得为void"));
            }
            expected.push(short(value));
        }
        if shorty.as_bytes() != expected {
            return Err(Error::Invalid("DEX原型shorty不符合实际类型"));
        }
        let key = (returns, args);
        if previous.as_ref().is_some_and(|before| before >= &key) {
            return Err(Error::Invalid("DEX原型索引未唯一排序"));
        }
        previous = Some(key);
    }
    Ok(())
}

pub(super) fn members(
    bytes: &[u8],
    header: &Header,
    strings: &Strings,
    types: &[String],
    control: &Control<'_>,
) -> Result<()> {
    prototypes(bytes, header, strings, types, control)?;
    for table_index in [3usize, 4] {
        let table = header.tables[table_index];
        let mut previous = None;
        for index in 0..table.count as usize {
            control.check()?;
            let position = table.offset + index * table.width;
            let owner = half(bytes, position)?;
            let target = half(bytes, position + 2)?;
            let name_index = word(bytes, position + 4)?;
            class(types, u32::from(owner))?;
            if table_index == 3 {
                if kind(types, u32::from(target))? == "V" {
                    return Err(Error::Invalid("DEX字段不得为void"));
                }
            } else if u32::from(target) >= header.tables[2].count {
                return Err(Error::Invalid("DEX方法原型引用越界"));
            }
            let name = strings.get(bytes, name_index, control)?;
            let base = name
                .strip_prefix('<')
                .and_then(|value| value.strip_suffix('>'))
                .unwrap_or(&name);
            if !simple(base, header.version) {
                return Err(Error::Invalid("DEX成员名称无效"));
            }
            let key = (owner, name_index, target);
            if previous.is_some_and(|before| before >= key) {
                return Err(Error::Invalid("DEX成员索引未唯一排序"));
            }
            previous = Some(key);
        }
    }
    Ok(())
}
