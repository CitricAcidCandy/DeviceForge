use super::{header::Header, strings::Strings, tables, word};
use crate::{Error, Result};
use deviceforge_android_package_core::Control;

pub(super) fn parse(
    bytes: &[u8],
    header: &Header,
    strings: &Strings,
    types: &[String],
    control: &Control<'_>,
) -> Result<Vec<String>> {
    let table = header.tables[5];
    let mut classes = Vec::with_capacity(table.count as usize);
    let mut previous = None;
    for index in 0..table.count as usize {
        control.check()?;
        let position = table.offset + index * table.width;
        let class_index = word(bytes, position)?;
        if previous.is_some_and(|before| before >= class_index) {
            return Err(Error::Invalid("DEX定义类索引未唯一排序"));
        }
        let descriptor = tables::class(types, class_index)?;
        let superclass = word(bytes, position + 8)?;
        if superclass != u32::MAX {
            tables::class(types, superclass)?;
        }
        let interfaces =
            tables::parameters(bytes, header, word(bytes, position + 12)? as usize, control)?;
        for &interface in &interfaces {
            tables::class(types, u32::from(interface))?;
        }
        if interfaces.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(Error::Invalid("DEX接口列表未唯一排序"));
        }
        let source = word(bytes, position + 16)?;
        if source != u32::MAX && !strings.contains(source) {
            return Err(Error::Invalid("DEX源文件名称引用越界"));
        }
        for (field, kind, alignment) in [(20usize, 0x2006, 4), (24, 0x2000, 1), (28, 0x2005, 1)] {
            let offset = word(bytes, position + field)? as usize;
            if offset != 0 {
                if !offset.is_multiple_of(alignment) {
                    return Err(Error::Invalid("DEX类数据引用未对齐"));
                }
                header.region(kind, offset, 1)?;
            }
        }
        classes.push(descriptor[1..descriptor.len() - 1].to_string());
        previous = Some(class_index);
    }
    classes.sort_unstable();
    control.check()?;
    Ok(classes)
}
