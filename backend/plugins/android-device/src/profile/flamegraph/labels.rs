//! 将元数据编码为无碰撞的 folded 标签，避免分号或换行伪造调用链。
use super::{Check, TEXT_LIMIT};
use crate::{Error, Result};

pub(super) fn push(target: &mut String, value: &str) -> Result<()> {
    if target
        .len()
        .checked_add(value.len())
        .is_none_or(|n| n > TEXT_LIMIT)
    {
        return Err(Error::TooLarge);
    }
    target.push_str(value);
    Ok(())
}

pub(super) fn escaped(target: &mut String, value: &str, check: Check<'_>) -> Result<()> {
    for ch in value.chars() {
        check()?;
        if matches!(ch, '%' | ';' | '\r' | '\n') {
            let mut encoded = [0; 4];
            for byte in ch.encode_utf8(&mut encoded).as_bytes() {
                push(target, &format!("%{byte:02X}"))?;
            }
        } else {
            let mut encoded = [0; 4];
            push(target, ch.encode_utf8(&mut encoded))?;
        }
    }
    Ok(())
}
