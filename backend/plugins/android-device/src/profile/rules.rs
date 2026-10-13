//! 设备时钟、原进程身份和回执规则；不执行命令。
use crate::{Error, Result, rules::performance};

pub(crate) const QUANTUM_NS: u64 = 10_000_000;
pub(crate) fn uptime(text: &str) -> Result<u64> {
    let mut fields = text.split_whitespace();
    let first = fields.next().ok_or(Error::Dependency("设备boottime文本为空"))?;
    let _idle = fields.next().ok_or(Error::Dependency("设备boottime文本不完整"))?;
    if fields.next().is_some() { return Err(Error::Dependency("设备boottime文本有额外字段")); }
    let (seconds, fraction) = first.split_once('.').ok_or(Error::Dependency("设备boottime不是百分秒文本"))?;
    if seconds.is_empty() || !seconds.bytes().all(|x| x.is_ascii_digit())
        || fraction.len() != 2 || !fraction.bytes().all(|x| x.is_ascii_digit()) {
        return Err(Error::Dependency("设备boottime精度或格式无效"));
    }
    seconds.parse::<u64>().ok().and_then(|x| x.checked_mul(1_000_000_000))
        .and_then(|x| x.checked_add(fraction.parse::<u64>().ok()?.checked_mul(QUANTUM_NS)?))
        .ok_or(Error::TooLarge)
}
pub(crate) fn end(begin: u64, observed: u64) -> Result<u64> {
    if observed < begin { return Err(Error::Dependency("设备boottime在采样期间倒退")); }
    observed.checked_add(QUANTUM_NS).ok_or(Error::TooLarge)
}
pub(crate) fn owned_process(stat: &str) -> Result<(u32,u64)> {
    let pid = stat.split_whitespace().next().and_then(|x| x.parse().ok())
        .filter(|x| *x > 0).ok_or(Error::Dependency("远端进程拥有记录缺少PID"))?;
    let (_,start) = performance::process(stat,pid)?;
    Ok((pid,start))
}
pub(crate) fn exit_code(text: &str) -> Result<u8> {
    let text = text.trim();
    if text.is_empty() || text.len() > 3 || !text.bytes().all(|x| x.is_ascii_digit()) {
        return Err(Error::Dependency("远端退出回执格式无效"));
    }
    text.parse().map_err(|_| Error::Dependency("远端退出码超出范围"))
}
pub(crate) fn token(text: &str) -> Result<()> {
    if text.len() != 64 || !text.bytes().all(|x| x.is_ascii_hexdigit() && !x.is_ascii_uppercase()) {
        return Err(Error::Invalid("远端工作目录所有权标记无效"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boottime_keeps_decimal_precision_and_quantization_bound() {
        assert_eq!(uptime("123.45 30.00\n").unwrap(),123_450_000_000);
        assert_eq!(end(123_450_000_000,123_460_000_000).unwrap(),123_470_000_000);
        for bad in ["1.001 0", "-1.00 0", "1e2.00 0", "1.00", "1.00 0 extra"] {
            assert!(uptime(bad).is_err());
        }
        assert!(end(2,1).is_err());
    }
    #[test]
    fn receipts_and_owner_tokens_reject_ambiguous_text() {
        assert_eq!(exit_code("0\n").unwrap(),0);
        for bad in ["", "0 0", "256", "-1", "+0"] { assert!(exit_code(bad).is_err()); }
        assert!(token(&"a".repeat(64)).is_ok());
        assert!(token(&"A".repeat(64)).is_err());
        assert!(token("../other").is_err());
    }
}
