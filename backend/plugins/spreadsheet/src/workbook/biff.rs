use super::cfb::u32_at;
use crate::{Error, Result, rules::{CELL_LIMIT, COLUMN_LIMIT, DENSE_LIMIT, ROW_LIMIT}, worker::Control};
fn u16_at(data: &[u8], offset: usize) -> Result<usize> {
    Ok(u16::from_le_bytes(data.get(offset..offset+2).ok_or(Error::Format)?.try_into().map_err(|_| Error::Format)?) as usize)
}
fn coordinate(row: usize, column: usize) -> Result<()> {
    if row > ROW_LIMIT || column >= COLUMN_LIMIT { return Err(Error::Limit); }
    Ok(())
}
fn record(stream: &[u8], position: usize) -> Result<(u16, &[u8], usize)> {
    let kind = u16_at(stream,position)? as u16;
    let len = u16_at(stream,position+2)?;
    if len > 8224 { return Err(Error::Limit); }
    let end = position.checked_add(4+len).ok_or(Error::Format)?;
    Ok((kind,stream.get(position+4..end).ok_or(Error::Format)?,end))
}
pub(super) fn precheck(stream: &[u8], control: &Control) -> Result<()> {
    let mut position = 0;
    let mut sheets = Vec::new();
    let mut version = 0;
    loop {
        control.check()?;
        let (kind,data,next) = record(stream,position)?;
        position = next;
        match kind {
            0x0809 => {
                version = u16_at(data,0)?;
                if !matches!(version,0x0500|0x0600) || u16_at(data,2)? != 5 { return Err(Error::Format); }
            }
            0x0085 => {
                if data.len() < 8 || data[5] != 0 { return Err(Error::Format); }
                sheets.push(u32_at(data,0)? as usize);
                if sheets.len() > 64 { return Err(Error::Limit); }
            }
            0x00fc => {
                if data.len() < 8 || u32_at(data,4)? as usize > DENSE_LIMIT { return Err(Error::Limit); }
            }
            0x002f => return Err(Error::Invalid("不支持加密XLS")),
            0x000a => break,
            _ => (),
        }
    }
    if version == 0 || sheets.is_empty() { return Err(Error::Format); }
    let mut unique = sheets.clone(); unique.sort_unstable(); unique.dedup();
    if unique.len() != sheets.len() { return Err(Error::Format); }
    let mut dense_total = 0usize;
    let mut cells_total = 0usize;
    for start in sheets {
        control.check()?;
        if start < position || start >= stream.len() { return Err(Error::Format); }
        let mut cursor = start;
        let mut dimension_area = 0;
        let mut first = true;
        let mut max_row = 0;
        let mut max_col = 0;
        let mut has_cell = false;
        loop {
            control.check()?;
            let (kind,data,next) = record(stream,cursor)?; cursor = next;
            if first {
                if kind != 0x0809 || u16_at(data,2)? != 0x10 { return Err(Error::Format); }
                first = false;
            }
            match kind {
                0x0200 => {
                    let (first_row,last_row,first_col,last_col) = if data.len() == 14 {
                        (u32_at(data,0)? as usize,u32_at(data,4)? as usize,u16_at(data,8)?,u16_at(data,10)?)
                    } else if data.len() == 10 {
                        (u16_at(data,0)?,u16_at(data,2)?,u16_at(data,4)?,u16_at(data,6)?)
                    } else { return Err(Error::Format); };
                    if first_row > last_row || first_col > last_col || last_row > ROW_LIMIT+1 || last_col > COLUMN_LIMIT {
                        return Err(Error::Limit);
                    }
                    dimension_area = dimension_area.max((last_row-first_row).max(1)*(last_col-first_col).max(1));
                }
                0x0203|0x0204|0x00d6|0x0205|0x027e|0x00fd|0x0006|0x00bd => {
                    let row = u16_at(data,0)?;
                    let column = if kind == 0x00bd { u16_at(data,data.len().checked_sub(2).ok_or(Error::Format)?)? }
                        else { u16_at(data,2)? };
                    coordinate(row,column)?;
                    if kind == 0x00bd && (u16_at(data,2)? > column || data.len() < 12 || !(data.len()-6).is_multiple_of(6)) {
                        return Err(Error::Format);
                    }
                    has_cell = true; max_row = max_row.max(row); max_col = max_col.max(column);
                    cells_total += if kind == 0x00bd { column-u16_at(data,2)?+1 } else { 1 };
                    if cells_total > DENSE_LIMIT { return Err(Error::Limit); }
                    if matches!(kind,0x0204|0x00d6) && u16_at(data,6)? > CELL_LIMIT { return Err(Error::Limit); }
                }
                0x0207 if u16_at(data,0)? > CELL_LIMIT => return Err(Error::Limit),
                0x000a => break,
                _ => (),
            }
        }
        let actual_area = if has_cell { (max_row+1)*(max_col+1) } else { 0 };
        dense_total = dense_total.checked_add(dimension_area.max(actual_area)).ok_or(Error::Limit)?;
        if dense_total > DENSE_LIMIT { return Err(Error::Limit); }
    }
    Ok(())
}
