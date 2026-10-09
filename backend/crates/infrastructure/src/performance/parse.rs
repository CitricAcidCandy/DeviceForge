use apk_domain::{Error, Result};
fn invalid(message: &str) -> Error {
    Error::Dependency(message.into())
}
fn integer(value: &str) -> Result<u64> {
    if value.is_empty() || !value.bytes().all(|ch| ch.is_ascii_digit()) {
        return Err(invalid("性能输出包含非法计数"));
    }
    value.parse().map_err(|_| invalid("性能计数超出范围"))
}
pub(super) fn pid(output: &str) -> Result<u32> {
    let value = integer(output.trim())?;
    u32::try_from(value)
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| invalid("未找到唯一的应用进程"))
}
pub(super) fn system(output: &str) -> Result<(u64, u32)> {
    let mut total = None;
    let mut cpus = std::collections::HashSet::new();
    for line in output.lines() {
        let mut fields = line.split_whitespace();
        let Some(name) = fields.next() else {
            continue;
        };
        if name == "cpu" {
            if total.is_some() {
                return Err(invalid("系统 CPU 汇总重复"));
            }
            let counters: Vec<_> = fields.map(integer).collect::<Result<_>>()?;
            if counters.len() < 4 || counters.len() > 10 {
                return Err(invalid("系统 CPU 字段数量无效"));
            }
            // guest 已包含于 user，guest_nice 已包含于 nice，不能重复相加。
            total = Some(counters.iter().take(8).try_fold(0u64, |sum, value| {
                sum.checked_add(*value)
                    .ok_or_else(|| invalid("系统 CPU 计数溢出"))
            })?);
        } else if let Some(index) = name
            .strip_prefix("cpu")
            .filter(|value| !value.is_empty() && value.bytes().all(|ch| ch.is_ascii_digit()))
        {
            let index = integer(index)?;
            if !cpus.insert(index) || cpus.len() > 4096 {
                return Err(invalid("CPU 核编号重复或数量超限"));
            }
        }
    }
    let total = total
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid("缺少系统 CPU 计数"))?;
    if cpus.is_empty() {
        return Err(invalid("缺少逻辑 CPU 核数"));
    }
    Ok((total, cpus.len() as u32))
}
pub(super) fn process(output: &str, expected_pid: u32) -> Result<(u64, u64)> {
    let output = output.trim();
    let open = output
        .find(" (")
        .ok_or_else(|| invalid("进程 stat 缺少名称"))?;
    let end = output
        .rfind(") ")
        .ok_or_else(|| invalid("进程 stat 名称未结束"))?;
    if end <= open || pid(&output[..open])? != expected_pid {
        return Err(invalid("进程 stat 编号不匹配"));
    }
    let fields: Vec<_> = output[end + 2..].split_whitespace().collect();
    if fields.len() < 20 || fields[0].len() != 1 {
        return Err(invalid("进程 stat 字段不完整"));
    }
    let ticks = integer(fields[11])?
        .checked_add(integer(fields[12])?)
        .ok_or_else(|| invalid("进程 CPU 计数溢出"))?;
    Ok((ticks, integer(fields[19])?))
}
fn set(value: &mut Option<u64>, next: u64) -> Result<()> {
    if value.is_some_and(|old| old != next) {
        return Err(invalid("内存汇总互相矛盾"));
    }
    *value = Some(next);
    Ok(())
}
pub(super) fn memory(output: &str, expected_pid: u32) -> Result<(u64, Option<u64>)> {
    let mut pss = None;
    let mut rss = None;
    let mut identity = false;
    for line in output.lines() {
        if let Some(header) = line.trim().strip_prefix("** MEMINFO in pid ") {
            let value = header
                .split_whitespace()
                .next()
                .ok_or_else(|| invalid("内存输出缺少进程编号"))?;
            if pid(value)? != expected_pid || identity {
                return Err(invalid("内存进程编号不匹配或重复"));
            }
            identity = true;
        }
        for (label, value) in [("TOTAL PSS:", &mut pss), ("TOTAL RSS:", &mut rss)] {
            if let Some(index) = line.find(label) {
                let count = line[index + label.len()..]
                    .split_whitespace()
                    .next()
                    .ok_or_else(|| invalid("内存汇总缺少数值"))?;
                set(value, integer(count)?)?;
            }
        }
        let mut fields = line.split_whitespace();
        if fields.next() == Some("TOTAL")
            && let Some(count) = fields
                .next()
                .filter(|value| value.bytes().all(|ch| ch.is_ascii_digit()))
        {
            set(&mut pss, integer(count)?)?;
        }
    }
    if !identity {
        return Err(invalid("内存输出缺少目标进程标识"));
    }
    Ok((pss.ok_or_else(|| invalid("内存输出缺少 TOTAL PSS"))?, rss))
}
