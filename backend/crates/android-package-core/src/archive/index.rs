use super::{
    ArchiveEntry, Directory, paths,
    preflight::{self, u16_at, u32_at},
};
use crate::{
    ArchiveProfile, Control, Error, LimitKind, Result, profiles::MAX_DECLARED_EXPANDED_BYTES,
};
use std::fs::File;

struct Member {
    entry: ArchiveEntry,
    name: Vec<u8>,
    flags: u16,
    method: u16,
    crc: u32,
    offset: u64,
}

pub(super) fn read(
    file: &mut File,
    _profile: ArchiveProfile,
    control: &Control<'_>,
) -> Result<(Directory, u64)> {
    let footer = preflight::inspect(file, control)?;
    let end = footer.directory_offset + footer.directory_size;
    let mut position = footer.directory_offset;
    let mut members = Vec::with_capacity(footer.count);
    let mut total = 0u64;
    for _ in 0..footer.count {
        control.check()?;
        if position.checked_add(46).is_none_or(|next| next > end) {
            return Err(Error::InvalidArchive("中央目录头部越界"));
        }
        preflight::seek(file, position, control)?;
        let mut header = [0; 46];
        preflight::read_exact(file, &mut header, control)?;
        if &header[..4] != b"PK\x01\x02" {
            return Err(Error::InvalidArchive("中央目录签名无效"));
        }
        let name_len = usize::from(u16_at(&header, 28));
        let extra_len = usize::from(u16_at(&header, 30));
        let comment_len = usize::from(u16_at(&header, 32));
        let next = position + 46 + (name_len + extra_len + comment_len) as u64;
        if next > end {
            return Err(Error::InvalidArchive("中央目录变长字段越界"));
        }
        let mut name = vec![0; name_len];
        let mut extra = vec![0; extra_len];
        preflight::read_exact(file, &mut name, control)?;
        preflight::read_exact(file, &mut extra, control)?;
        preflight::check_extra(&extra)?;
        let flags = u16_at(&header, 8);
        let method = u16_at(&header, 10);
        let size = u32_at(&header, 24);
        let compressed = u32_at(&header, 20);
        let offset = u32_at(&header, 42);
        if u16_at(&header, 34) != 0
            || [size, compressed, offset].contains(&u32::MAX)
            || flags & 0x2041 != 0
            || ![0, 8].contains(&method)
        {
            return Err(Error::InvalidArchive("不支持分卷、加密、ZIP64 或压缩方法"));
        }
        if method == 0 && size != compressed {
            return Err(Error::InvalidArchive("Stored 长度不一致"));
        }
        let decoded = decode_name(&name, &extra, flags)?;
        if !paths::safe_entry(&decoded) {
            return Err(Error::InvalidArchive("成员路径不安全"));
        }
        let directory = decoded.ends_with('/');
        let system = header[5];
        let mode = if [3, 19].contains(&system) {
            u32_at(&header, 38) >> 16
        } else {
            0
        };
        let node_type = mode & 0o170000;
        if ![0, 0o100000, 0o040000].contains(&node_type)
            || (node_type == 0o040000 && !directory)
            || (node_type == 0o100000 && directory)
            || (directory && size != 0)
        {
            return Err(Error::InvalidArchive("成员不是普通文件或目录"));
        }
        total = total.checked_add(u64::from(size)).ok_or(Error::limit(
            LimitKind::ExpandedBytes,
            MAX_DECLARED_EXPANDED_BYTES,
        ))?;
        if total > MAX_DECLARED_EXPANDED_BYTES {
            return Err(Error::limit(
                LimitKind::ExpandedBytes,
                MAX_DECLARED_EXPANDED_BYTES,
            ));
        }
        members.push(Member {
            entry: ArchiveEntry {
                name: decoded,
                size: u64::from(size),
                compressed_size: u64::from(compressed),
                directory,
            },
            name,
            flags,
            method,
            crc: u32_at(&header, 16),
            offset: u64::from(offset),
        });
        position = next;
    }
    if position != end {
        return Err(Error::InvalidArchive("中央目录有未计数内容"));
    }
    let mut ranges = Vec::with_capacity(members.len());
    for member in &members {
        control.check()?;
        ranges.push((
            member.offset,
            check_local(file, member, footer.directory_offset, control)?,
        ));
    }
    ranges.sort_unstable();
    if ranges.windows(2).any(|pair| pair[0].1 > pair[1].0) {
        return Err(Error::InvalidArchive("成员数据范围重叠"));
    }
    control.check()?;
    Ok((
        Directory {
            entries: members.into_iter().map(|member| member.entry).collect(),
            declared_size: total,
        },
        footer.file_size,
    ))
}

fn check_local(
    file: &mut File,
    member: &Member,
    directory_start: u64,
    control: &Control<'_>,
) -> Result<u64> {
    if member.offset + 30 > directory_start {
        return Err(Error::InvalidArchive("本地头部越界"));
    }
    preflight::seek(file, member.offset, control)?;
    let mut header = [0; 30];
    preflight::read_exact(file, &mut header, control)?;
    if &header[..4] != b"PK\x03\x04"
        || u16_at(&header, 6) != member.flags
        || u16_at(&header, 8) != member.method
    {
        return Err(Error::InvalidArchive("本地头部与中央目录不一致"));
    }
    if [u32_at(&header, 18), u32_at(&header, 22)].contains(&u32::MAX) {
        return Err(Error::InvalidArchive("本地头部不支持 ZIP64"));
    }
    let name_len = usize::from(u16_at(&header, 26));
    let extra_len = usize::from(u16_at(&header, 28));
    let data_start = member.offset + 30 + (name_len + extra_len) as u64;
    let data_end = data_start + member.entry.compressed_size;
    if data_end > directory_start {
        return Err(Error::InvalidArchive("成员数据越界"));
    }
    let mut name = vec![0; name_len];
    let mut extra = vec![0; extra_len];
    preflight::read_exact(file, &mut name, control)?;
    preflight::read_exact(file, &mut extra, control)?;
    if name != member.name {
        return Err(Error::InvalidArchive("本地成员名不一致"));
    }
    preflight::check_extra(&extra)?;
    if member.flags & 8 == 0 {
        if u32_at(&header, 14) != member.crc
            || u64::from(u32_at(&header, 18)) != member.entry.compressed_size
            || u64::from(u32_at(&header, 22)) != member.entry.size
        {
            return Err(Error::InvalidArchive("本地长度或 CRC 声明不一致"));
        }
        return Ok(data_end);
    }
    if data_end + 12 > directory_start {
        return Err(Error::InvalidArchive("数据描述符越界"));
    }
    preflight::seek(file, data_end, control)?;
    let mut descriptor = [0; 16];
    preflight::read_exact(file, &mut descriptor[..12], control)?;
    let values = if &descriptor[..4] == b"PK\x07\x08" {
        if data_end + 16 > directory_start {
            return Err(Error::InvalidArchive("数据描述符越界"));
        }
        preflight::read_exact(file, &mut descriptor[12..], control)?;
        &descriptor[4..]
    } else {
        &descriptor[..12]
    };
    if u32_at(values, 0) != member.crc
        || u64::from(u32_at(values, 4)) != member.entry.compressed_size
        || u64::from(u32_at(values, 8)) != member.entry.size
    {
        return Err(Error::InvalidArchive("数据描述符不一致"));
    }
    Ok(data_end
        + if &descriptor[..4] == b"PK\x07\x08" {
            16
        } else {
            12
        })
}

fn decode_name(bytes: &[u8], extra: &[u8], flags: u16) -> Result<String> {
    let mut position = 0;
    while position < extra.len() {
        let tag = u16_at(extra, position);
        let length = usize::from(u16_at(extra, position + 2));
        let value = &extra[position + 4..position + 4 + length];
        // 扩展校验和仍由 ZIP 解码器逐条验证，目录保留它采用的 Unicode 名称。
        if tag == 0x7075 {
            if value.len() < 5 || value[0] != 1 {
                return Err(Error::InvalidArchive("Unicode 名称扩展无效"));
            }
            return String::from_utf8(value[5..].to_vec())
                .map_err(|_| Error::InvalidArchive("Unicode 名称不是 UTF-8"));
        }
        position += 4 + length;
    }
    if flags & 0x800 != 0 {
        return Ok(String::from_utf8_lossy(bytes).into_owned());
    }
    // 兼容 ZIP 未标 UTF-8 时的 CP437 名称，避免把已有合法包缩减为仅 ASCII。
    const HIGH: &str = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
    let table: Vec<char> = HIGH.chars().collect();
    Ok(bytes
        .iter()
        .map(|&byte| {
            if byte < 128 {
                char::from(byte)
            } else {
                table[usize::from(byte - 128)]
            }
        })
        .collect())
}
