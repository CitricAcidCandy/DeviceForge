//! 从叶到根样本生成有界 folded 栈；仅输出观测到的链，不补造截断部分。
mod labels;
mod model;
#[cfg(test)]
mod tests;

use super::report::{Report, StackSample};
use crate::{Error, Result};
pub(crate) use model::{Folded, Options};
use model::{Quality, Summary, Weight};
use std::collections::BTreeMap;

const SAMPLE_LIMIT: usize = 100_000;
const FRAME_LIMIT: usize = 1_000_000;
const DEPTH_LIMIT: usize = 256;
const FIELD_LIMIT: usize = 4096;
const TEXT_LIMIT: usize = 32 * 1024 * 1024;
type Check<'a> = &'a (dyn Fn() -> Result<()> + Sync);

fn decimal(value: &str) -> Result<u64> {
    if value.is_empty()
        || value.len() > 20
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(Error::Invalid("火焰图计数或时间不是规范十进制整数"));
    }
    value
        .parse()
        .map_err(|_| Error::Invalid("火焰图计数或时间超过u64范围"))
}

fn field(value: &str, budget: &mut usize) -> Result<()> {
    *budget = budget
        .checked_add(value.len())
        .filter(|n| *n <= TEXT_LIMIT)
        .ok_or(Error::TooLarge)?;
    if value.len() > FIELD_LIMIT {
        return Err(Error::TooLarge);
    }
    Ok(())
}

fn validate(
    sample: &StackSample,
    budget: &mut usize,
    frames: &mut usize,
    check: Check<'_>,
) -> Result<(u64, u64)> {
    let time = decimal(&sample.time_ns)?;
    let count = decimal(&sample.event_count)?;
    if sample.callchain.len() > DEPTH_LIMIT {
        return Err(Error::TooLarge);
    }
    *frames = frames
        .checked_add(sample.callchain.len())
        .filter(|n| *n <= FRAME_LIMIT)
        .ok_or(Error::TooLarge)?;
    for value in [sample.event_type.as_deref(), sample.thread_name.as_deref()]
        .into_iter()
        .flatten()
    {
        field(value, budget)?;
    }
    for frame in &sample.callchain {
        check()?;
        for value in [
            frame.file.as_deref(),
            frame.symbol.as_deref(),
            Some(frame.execution_type.as_str()),
            Some(frame.address.as_str()),
        ]
        .into_iter()
        .flatten()
        {
            field(value, budget)?;
        }
        if !frame
            .address
            .strip_prefix("0x")
            .is_some_and(|value| !value.is_empty() && u64::from_str_radix(value, 16).is_ok())
        {
            return Err(Error::Invalid("火焰图帧地址不是u64十六进制整数"));
        }
    }
    Ok((time, count))
}

fn selected(sample: &StackSample, time: u64, options: &Options) -> bool {
    options
        .process_id
        .is_none_or(|pid| sample.process_id == Some(pid))
        && options.thread_id.is_none_or(|tid| sample.thread_id == tid)
        && options.begin_ns.is_none_or(|begin| time >= begin)
        && options.end_ns.is_none_or(|end| time < end)
}

fn quality(sample: &StackSample, quality: &mut Quality, check: Check<'_>) -> Result<()> {
    let depth = sample.callchain.len();
    quality.empty_callchain_sample_count += usize::from(depth == 0);
    quality.single_frame_sample_count += usize::from(depth == 1);
    quality.max_callchain_depth = quality.max_callchain_depth.max(depth);
    if let Some(unwind) = &sample.unwinding {
        quality.unwinding_error_sample_count += usize::from(
            unwind.raw_error_code.is_some_and(|code| code != 0)
                || unwind.error_code.is_some_and(|code| code != 0),
        );
    } else {
        quality.unwinding_metadata_missing_sample_count += 1;
    }
    let mut missing = false;
    for frame in &sample.callchain {
        check()?;
        if frame.symbol.as_deref().is_none_or(str::is_empty) {
            quality.missing_symbol_frame_count += 1;
            missing = true;
        }
    }
    quality.missing_symbol_sample_count += usize::from(missing);
    Ok(())
}

fn stack_key(sample: &StackSample, check: Check<'_>) -> Result<String> {
    let mut key = String::new();
    let event = serde_json::to_string(&sample.event_type)
        .map_err(|_| Error::Dependency("火焰图事件标签编码失败"))?;
    labels::escaped(&mut key, &format!("event={event}"), check)?;
    labels::push(&mut key, ";pid=")?;
    labels::push(
        &mut key,
        &sample
            .process_id
            .map_or_else(|| "null".into(), |pid| pid.to_string()),
    )?;
    labels::push(&mut key, ";tid=")?;
    labels::push(&mut key, &sample.thread_id.to_string())?;
    // 输入合同为叶到根，folded 的第一层应当是实际已观测到的根。
    for frame in sample.callchain.iter().rev() {
        check()?;
        let symbol = frame.symbol.as_deref().filter(|value| !value.is_empty());
        let address = if symbol.is_none() {
            Some(frame.address.as_str())
        } else {
            None
        };
        let label = serde_json::to_string(&(
            frame.execution_type.as_str(),
            frame.file.as_deref(),
            symbol,
            address,
        ))
        .map_err(|_| Error::Dependency("火焰图帧标签编码失败"))?;
        labels::push(&mut key, ";")?;
        labels::escaped(&mut key, &label, check)?;
    }
    Ok(key)
}

pub(crate) fn folded(report: &Report, options: &Options, check: Check<'_>) -> Result<Folded> {
    check()?;
    if report.samples.len() > SAMPLE_LIMIT {
        return Err(Error::TooLarge);
    }
    if options
        .begin_ns
        .zip(options.end_ns)
        .is_some_and(|(begin, end)| begin > end)
    {
        return Err(Error::Invalid("火焰图时间窗口顺序无效"));
    }
    let mut stacks = BTreeMap::<String, u128>::new();
    let mut summary = Summary {
        format_version: 1,
        clock: "boottime",
        weight: options.weight,
        process_id: options.process_id,
        thread_id: options.thread_id,
        begin_ns: options.begin_ns.map(|value| value.to_string()),
        end_ns: options.end_ns.map(|value| value.to_string()),
        input_sample_count: report.samples.len(),
        included_sample_count: 0,
        drawn_sample_count: 0,
        folded_stack_count: 0,
        total_weight: String::new(),
        drawn_weight: String::new(),
        empty_callchain_weight: String::new(),
        quality: Quality::default(),
    };
    let (mut total, mut drawn, mut empty) = (0u128, 0u128, 0u128);
    let (mut input_budget, mut frame_count, mut output_budget) = (0usize, 0usize, 0usize);
    for sample in &report.samples {
        check()?;
        let (time, count) = validate(sample, &mut input_budget, &mut frame_count, check)?;
        if !selected(sample, time, options) {
            continue;
        }
        summary.included_sample_count += 1;
        quality(sample, &mut summary.quality, check)?;
        let weight = match options.weight {
            Weight::Samples => 1,
            Weight::EventCount => count as u128,
        };
        total = total.checked_add(weight).ok_or(Error::TooLarge)?;
        if sample.callchain.is_empty() {
            empty = empty.checked_add(weight).ok_or(Error::TooLarge)?;
            continue;
        }
        summary.drawn_sample_count += 1;
        drawn = drawn.checked_add(weight).ok_or(Error::TooLarge)?;
        let key = stack_key(sample, check)?;
        if !stacks.contains_key(&key) {
            // 每行预留空格、u128 的最多39位十进制数及换行。
            output_budget = output_budget
                .checked_add(key.len() + 41)
                .filter(|n| *n <= TEXT_LIMIT)
                .ok_or(Error::TooLarge)?;
        }
        let entry = stacks.entry(key).or_default();
        *entry = entry.checked_add(weight).ok_or(Error::TooLarge)?;
    }
    summary.folded_stack_count = stacks.len();
    summary.total_weight = total.to_string();
    summary.drawn_weight = drawn.to_string();
    summary.empty_callchain_weight = empty.to_string();
    let mut text = String::with_capacity(output_budget);
    for (key, weight) in stacks {
        check()?;
        labels::push(&mut text, &key)?;
        labels::push(&mut text, " ")?;
        labels::push(&mut text, &weight.to_string())?;
        labels::push(&mut text, "\n")?;
    }
    check()?;
    Ok(Folded { text, summary })
}
