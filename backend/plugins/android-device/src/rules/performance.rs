//! 固定性能工具输出的纯规则；不访问设备、时钟、文件或会话存储。
pub(crate) mod fps;
pub(crate) mod missing;

use crate::{Error, Result};
use std::collections::HashSet;

pub(crate) type Check<'a> = &'a (dyn Fn() -> Result<()> + Sync);

pub(crate) fn package(value: &str) -> Result<()> {
    if value.len() > 200
        || !value.contains('.')
        || value.split('.').any(|part| {
            let mut bytes = part.bytes();
            !bytes
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic() || first == b'_')
                || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        })
    {
        return Err(Error::Invalid("性能目标必须为合法Android包名"));
    }
    Ok(())
}

pub(crate) fn output(stdout: &[u8], stderr: &[u8]) -> Result<String> {
    // 保留旧探针的双流 lossy 合并，不能用普通动作的严格 UTF-8 改变本批合同。
    let output = format!(
        "{}\n{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    );
    let lower = output.to_ascii_lowercase();
    if [
        "permission denied",
        "permission denial",
        "no such file",
        "error:",
        "exception",
        "not found",
        "device offline",
        "unauthorized",
    ]
    .iter()
    .any(|text| lower.contains(text))
    {
        return Err(Error::Dependency("设备拒绝性能采样或进程已退出"));
    }
    Ok(output.trim().to_owned())
}

fn integer(value: &str) -> Result<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(Error::Dependency("性能输出包含非法计数"));
    }
    value
        .parse()
        .map_err(|_| Error::Dependency("性能计数超出范围"))
}

pub(crate) fn pid(output: &str) -> Result<u32> {
    let value = integer(output.trim())?;
    u32::try_from(value)
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or(Error::Dependency("未找到唯一的应用进程"))
}

pub(crate) fn process(output: &str, expected_pid: u32) -> Result<(u64, u64)> {
    let output = output.trim();
    let open = output
        .find(" (")
        .ok_or(Error::Dependency("进程stat缺少名称"))?;
    let end = output
        .rfind(") ")
        .ok_or(Error::Dependency("进程stat名称未结束"))?;
    if end <= open || pid(&output[..open])? != expected_pid {
        return Err(Error::Dependency("进程stat编号不匹配"));
    }
    let fields: Vec<_> = output[end + 2..].split_whitespace().collect();
    if fields.len() < 20 || fields[0].len() != 1 {
        return Err(Error::Dependency("进程stat字段不完整"));
    }
    let ticks = integer(fields[11])?
        .checked_add(integer(fields[12])?)
        .ok_or(Error::Dependency("进程CPU计数溢出"))?;
    Ok((ticks, integer(fields[19])?))
}

pub(crate) fn system(output: &str, check: Check<'_>) -> Result<(u64, u32)> {
    let mut total = None;
    let mut cpus = HashSet::new();
    for line in output.lines() {
        check()?;
        let mut fields = line.split_whitespace();
        let Some(name) = fields.next() else {
            continue;
        };
        if name == "cpu" {
            if total.is_some() {
                return Err(Error::Dependency("系统CPU汇总重复"));
            }
            // 第十一个字段一律失败，避免坏输出生成与文本规模相同的计数数组。
            let counters = fields.take(11).map(integer).collect::<Result<Vec<_>>>()?;
            if !(4..=10).contains(&counters.len()) {
                return Err(Error::Dependency("系统CPU字段数量无效"));
            }
            // guest/guest_nice 已包含于 user/nice，只累计前八个字段。
            total = Some(counters.iter().take(8).try_fold(0_u64, |sum, value| {
                sum.checked_add(*value)
                    .ok_or(Error::Dependency("系统CPU计数溢出"))
            })?);
        } else if let Some(index) = name
            .strip_prefix("cpu")
            .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
            && (!cpus.insert(integer(index)?) || cpus.len() > 4096)
        {
            return Err(Error::Dependency("CPU核编号重复或数量超限"));
        }
    }
    let total = total
        .filter(|value| *value > 0)
        .ok_or(Error::Dependency("缺少系统CPU计数"))?;
    if cpus.is_empty() {
        return Err(Error::Dependency("缺少逻辑CPU核数"));
    }
    Ok((total, cpus.len() as u32))
}

fn set(value: &mut Option<u64>, next: u64) -> Result<()> {
    if value.is_some_and(|old| old != next) {
        return Err(Error::Dependency("内存汇总互相矛盾"));
    }
    *value = Some(next);
    Ok(())
}

// Android 9的单列PSS摘要只保留已知条目，未知节标题不能沿用当前列含义。
fn app_summary_row(line: &str) -> Result<bool> {
    let Some((label, count)) = line.split_once(':') else {
        return Ok(false);
    };
    if !matches!(
        label,
        "Java Heap" | "Native Heap" | "Code" | "Stack" | "Graphics" | "Private Other" | "System"
    ) {
        return Ok(false);
    }
    let mut fields = count.split_whitespace();
    let Some(count) = fields.next() else {
        return Err(Error::Dependency("内存摘要条目缺少数值"));
    };
    integer(count)?;
    if fields.next().is_some() {
        return Err(Error::Dependency("内存摘要条目包含未知列"));
    }
    Ok(true)
}

pub(crate) fn memory(
    output: &str,
    expected_pid: u32,
    check: Check<'_>,
) -> Result<(u64, Option<u64>)> {
    let mut pss = None;
    let mut rss = None;
    let mut identity = false;
    enum AppSummary {
        Closed,
        Heading,
        PssRows,
        Consumed,
    }
    let mut app_summary = AppSummary::Closed;
    let mut summary_total_seen = false;
    for line in output.lines() {
        check()?;
        if let Some(header) = line.trim().strip_prefix("** MEMINFO in pid ") {
            let value = header
                .split_whitespace()
                .next()
                .ok_or(Error::Dependency("内存输出缺少进程编号"))?;
            if pid(value)? != expected_pid || identity {
                return Err(Error::Dependency("内存进程编号不匹配或重复"));
            }
            identity = true;
            app_summary = AppSummary::Closed;
        }
        let trimmed = line.trim();
        // 目标身份、摘要标题和PSS列头必须按序出现，TOTAL消费后不跨节读取。
        app_summary = match app_summary {
            _ if trimmed == "App Summary" && identity => AppSummary::Heading,
            AppSummary::Heading if trimmed.is_empty() => AppSummary::Heading,
            AppSummary::Heading if trimmed == "Pss(KB)" => AppSummary::PssRows,
            AppSummary::PssRows
                if trimmed.is_empty() || trimmed.bytes().all(|byte| byte == b'-') =>
            {
                AppSummary::PssRows
            }
            AppSummary::PssRows if trimmed.starts_with("TOTAL:") => {
                if summary_total_seen {
                    return Err(Error::Dependency("内存PSS摘要TOTAL重复"));
                }
                let count = trimmed["TOTAL:".len()..]
                    .split_whitespace()
                    .next()
                    .ok_or(Error::Dependency("内存汇总缺少数值"))?;
                set(&mut pss, integer(count)?)?;
                summary_total_seen = true;
                AppSummary::Consumed
            }
            AppSummary::PssRows if app_summary_row(trimmed)? => AppSummary::PssRows,
            AppSummary::Consumed if trimmed.is_empty() => AppSummary::Consumed,
            AppSummary::Consumed if trimmed.starts_with("TOTAL:") => {
                return Err(Error::Dependency("内存PSS摘要TOTAL重复"));
            }
            _ => AppSummary::Closed,
        };
        for (label, value) in [("TOTAL PSS:", &mut pss), ("TOTAL RSS:", &mut rss)] {
            if let Some(index) = line.find(label) {
                let count = line[index + label.len()..]
                    .split_whitespace()
                    .next()
                    .ok_or(Error::Dependency("内存汇总缺少数值"))?;
                set(value, integer(count)?)?;
            }
        }
        let mut fields = line.split_whitespace();
        if fields.next() == Some("TOTAL")
            && let Some(count) = fields
                .next()
                .filter(|value| value.bytes().all(|byte| byte.is_ascii_digit()))
        {
            set(&mut pss, integer(count)?)?;
        }
    }
    if !identity {
        return Err(Error::Dependency("内存输出缺少目标进程标识"));
    }
    Ok((pss.ok_or(Error::Dependency("内存输出缺少TOTAL PSS"))?, rss))
}

#[cfg(test)]
mod tests;
