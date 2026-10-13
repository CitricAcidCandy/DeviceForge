use crate::{Error, Result, rules::{DENSE_LIMIT, FILE_LIMIT}, worker::Control};
use std::collections::BTreeSet;
const END: u32 = 0xffff_fffe;
const FREE: u32 = 0xffff_ffff;
const FAT: u32 = 0xffff_fffd;
const DIF: u32 = 0xffff_fffc;
fn u16_at(bytes: &[u8], offset: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(bytes.get(offset..offset + 2).ok_or(Error::Format)?.try_into().map_err(|_| Error::Format)?))
}
pub(super) fn u32_at(bytes: &[u8], offset: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(bytes.get(offset..offset + 4).ok_or(Error::Format)?.try_into().map_err(|_| Error::Format)?))
}
fn sector(bytes: &[u8], size: usize, id: u32) -> Result<&[u8]> {
    let start = (id as usize).checked_add(1).and_then(|n| n.checked_mul(size)).ok_or(Error::Format)?;
    bytes.get(start..start + size).ok_or(Error::Format)
}
fn numbers(bytes: &[u8]) -> Result<Vec<u32>> {
    bytes.chunks_exact(4).map(|part| u32_at(part, 0)).collect()
}
fn chain(start: u32, table: &[u32], count: usize, control: &Control) -> Result<Vec<u32>> {
    let mut id = start;
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    while id != END {
        control.check()?;
        if id as usize >= count || !seen.insert(id) { return Err(Error::Format); }
        result.push(id);
        id = *table.get(id as usize).ok_or(Error::Format)?;
    }
    Ok(result)
}
fn acyclic(table: &[u32], count: usize, control: &Control) -> Result<()> {
    let mut state = vec![0u8; count];
    for index in 0..count {
        control.check()?;
        let mut path = Vec::new();
        let mut current = index;
        while current < count && state[current] == 0 {
            state[current] = 1;
            path.push(current);
            let next = *table.get(current).ok_or(Error::Format)?;
            if matches!(next, END | FREE | FAT | DIF) { break; }
            if next as usize >= count { return Err(Error::Format); }
            current = next as usize;
            if state[current] == 1 { return Err(Error::Format); }
        }
        for id in path { state[id] = 2; }
    }
    Ok(())
}
fn collect(bytes: &[u8], size: usize, ids: &[u32], length: Option<usize>, control: &Control) -> Result<Vec<u8>> {
    let available = ids.len().checked_mul(size).ok_or(Error::Limit)?;
    let length = length.unwrap_or(available);
    if length > FILE_LIMIT || length > available
        || length.div_ceil(size) != ids.len() { return Err(Error::Format); }
    let mut result = Vec::with_capacity(length);
    for id in ids {
        control.check()?;
        let part = sector(bytes, size, *id)?;
        let remaining = length - result.len();
        result.extend_from_slice(&part[..part.len().min(remaining)]);
    }
    Ok(result)
}

/// 在库解析前限制全部容器声明、FAT链和上游错误偏移产生的容量。
pub(super) fn workbook(bytes: &[u8], control: &Control) -> Result<Vec<u8>> {
    if bytes.len() < 512 || bytes[..8] != [0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]
        || u16_at(bytes,28)? != 0xfffe || u16_at(bytes,32)? != 6
        || u32_at(bytes,56)? != 4096 { return Err(Error::Format); }
    let version = u16_at(bytes,26)?;
    let size = match (version, u16_at(bytes,30)?) { (3,9) => 512, (4,12) => 4096, _ => return Err(Error::Format) };
    if !bytes.len().is_multiple_of(size) || bytes.len() < size * 2 { return Err(Error::Format); }
    let count = bytes.len() / size - 1;
    let fat_count = u32_at(bytes,44)? as usize;
    let mini_count = u32_at(bytes,64)? as usize;
    let dif_count = u32_at(bytes,72)? as usize;
    if fat_count == 0 || fat_count > count || mini_count > count || dif_count > count
        || u32_at(bytes,40)? as usize > count { return Err(Error::Format); }
    // calamine 0.36.1 从62读取DIFAT容量；输入与该实际读法一起受限。
    if u32_at(bytes,62)? as usize > DENSE_LIMIT { return Err(Error::Limit); }
    let mut fat_ids = numbers(&bytes[76..512])?.into_iter().filter(|x| *x != FREE).collect::<Vec<_>>();
    let mut dif_id = u32_at(bytes,68)?;
    let mut visited = BTreeSet::new();
    for _ in 0..dif_count {
        control.check()?;
        if dif_id as usize >= count || !visited.insert(dif_id) { return Err(Error::Format); }
        let part = sector(bytes,size,dif_id)?;
        fat_ids.extend(numbers(&part[..size-4])?.into_iter().filter(|x| *x != FREE));
        dif_id = u32_at(part,size-4)?;
    }
    if dif_id != END || fat_ids.len() != fat_count || fat_ids.iter().any(|x| *x as usize >= count)
        || fat_ids.iter().copied().collect::<BTreeSet<_>>().len() != fat_ids.len() { return Err(Error::Format); }
    let mut table = Vec::new();
    for id in &fat_ids { table.extend(numbers(sector(bytes,size,*id)?)?); }
    if table.len() < count { return Err(Error::Format); }
    for id in fat_ids { if table[id as usize] != FAT { return Err(Error::Format); } }
    for id in visited { if table[id as usize] != DIF { return Err(Error::Format); } }
    acyclic(&table,count,control)?;
    let dirs = collect(bytes,size,&chain(u32_at(bytes,48)?,&table,count,control)?,None,control)?;
    if dirs.is_empty() || dirs[66] != 5 { return Err(Error::Format); }
    let length = |entry: &[u8]| -> Result<usize> {
        let value = u64::from_le_bytes(entry.get(120..128).ok_or(Error::Format)?.try_into().map_err(|_| Error::Format)?);
        if value > FILE_LIMIT as u64 || (version == 3 && value > u32::MAX as u64) { return Err(Error::Limit); }
        Ok(value as usize)
    };
    let root_len = length(&dirs[..128])?;
    let root_start = u32_at(&dirs,116)?;
    let root = if root_len == 0 { Vec::new() } else {
        collect(bytes,size,&chain(root_start,&table,count,control)?,Some(root_len),control)?
    };
    let mini_ids = if mini_count == 0 {
        if !matches!(u32_at(bytes,60)?, END | FREE) { return Err(Error::Format); }
        Vec::new()
    } else { chain(u32_at(bytes,60)?,&table,count,control)? };
    if mini_ids.len() != mini_count { return Err(Error::Format); }
    let mini_table = numbers(&collect(bytes,size,&mini_ids,Some(mini_count * size),control)?)?;
    let mini_sectors = root.len().div_ceil(64);
    if mini_sectors > 0 { acyclic(&mini_table,mini_sectors,control)?; }
    let mut workbook = None;
    for entry in dirs.chunks_exact(128) {
        control.check()?;
        if entry[66] == 0 { continue; }
        if !matches!(entry[66],1|2|5) { return Err(Error::Format); }
        let name_len = u16_at(entry,64)? as usize;
        if !(2..=64).contains(&name_len) || !name_len.is_multiple_of(2) { return Err(Error::Format); }
        let name = String::from_utf16(&entry[..name_len-2].chunks_exact(2)
            .map(|p| u16::from_le_bytes([p[0],p[1]])).collect::<Vec<_>>()).map_err(|_| Error::Format)?;
        for offset in [68,72,76] {
            let pointer = u32_at(entry,offset)?;
            if pointer != FREE && pointer as usize >= dirs.len()/128 { return Err(Error::Format); }
        }
        if entry[66] != 2 { continue; }
        let len = length(entry)?;
        let start = u32_at(entry,116)?;
        let data = if len == 0 { Vec::new() } else if len < 4096 {
            let ids = chain(start,&mini_table,mini_sectors,control)?;
            if ids.len() != len.div_ceil(64) { return Err(Error::Format); }
            let mut data = Vec::with_capacity(len);
            for id in ids {
                control.check()?;
                let pos = id as usize * 64;
                let size = (len-data.len()).min(64);
                data.extend_from_slice(root.get(pos..pos+size).ok_or(Error::Format)?);
            }
            data
        } else { collect(bytes,size,&chain(start,&table,count,control)?,Some(len),control)? };
        if matches!(name.to_ascii_lowercase().as_str(),"book"|"workbook") {
            if workbook.replace(data).is_some() { return Err(Error::Format); }
        }
    }
    workbook.ok_or(Error::Format)
}
