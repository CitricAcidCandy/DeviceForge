//! Simpleperf官方报告解析；不依赖宿主或官方工具的运行输出文本格式。
mod model;
mod sample;
mod tables;
mod wire;
use crate::{Error, Result};
pub(crate) use model::{Report, StackFrame, StackSample};
use std::collections::BTreeMap;
type Check<'a> = &'a (dyn Fn() -> Result<()> + Sync);
struct State {
    samples: Vec<sample::RawSample>,
    files: BTreeMap<u32, tables::File>,
    threads: BTreeMap<u32, tables::Thread>,
    events: Option<Vec<String>>,
    lost: Option<(u64, u64)>,
    chain_count: usize,
}
impl State {
    fn record(&mut self, bytes: &[u8], check: Check<'_>) -> Result<()> {
        let mut reader = wire::Reader::new(bytes);
        let mut seen = false;
        while let Some((field, value)) = reader.next()? {
            check()?;
            if (1..=6).contains(&field) {
                if std::mem::replace(&mut seen, true) {
                    return Err(Error::Dependency("堆栈Record包含多个消息"));
                }
                let bytes = wire::bytes(value)?;
                match field {
                    1 => {
                        if self.samples.len() >= 100000 {
                            return Err(Error::TooLarge);
                        }
                        let sample = sample::parse(bytes, check)?;
                        self.chain_count = self
                            .chain_count
                            .checked_add(sample.chain.len())
                            .filter(|v| *v <= 1000000)
                            .ok_or(Error::TooLarge)?;
                        self.samples.push(sample);
                    }
                    2 => wire::singular(&mut self.lost, tables::lost(bytes, check)?)?,
                    3 => {
                        if self.files.len() >= 4096 {
                            return Err(Error::TooLarge);
                        }
                        let file = tables::file(bytes, check)?;
                        if self.files.insert(file.id, file).is_some() {
                            return Err(Error::Dependency("堆栈文件表编号重复"));
                        }
                    }
                    4 => {
                        if self.threads.len() >= 65536 {
                            return Err(Error::TooLarge);
                        }
                        let thread = tables::thread(bytes, check)?;
                        if self.threads.insert(thread.id, thread).is_some() {
                            return Err(Error::Dependency("堆栈线程表编号重复"));
                        }
                    }
                    5 => wire::singular(&mut self.events, tables::meta(bytes, check)?)?,
                    6 => tables::context_switch(bytes, check)?,
                    _ => unreachable!(),
                }
            }
        }
        if !seen {
            return Err(Error::Dependency("堆栈Record缺少已知消息"));
        }
        Ok(())
    }
    fn resolve(mut self, check: Check<'_>) -> Result<Report> {
        let (reported_sample_count, lost_count) =
            self.lost.ok_or(Error::Dependency("堆栈报告缺少丢样统计"))?;
        if reported_sample_count != self.samples.len() as u64 {
            return Err(Error::Dependency("堆栈报告样本统计不一致"));
        }
        let events = self
            .events
            .ok_or(Error::Dependency("堆栈报告缺少事件元数据"))?;
        self.samples = sort_samples(self.samples, check)?;
        let mut samples = Vec::with_capacity(self.samples.len());
        let mut output_budget = 0usize;
        for raw in self.samples {
            check()?;
            output_budget = output_budget
                .checked_add(512)
                .filter(|n| *n <= 32 * 1024 * 1024)
                .ok_or(Error::TooLarge)?;
            let thread = self
                .threads
                .get(&raw.thread)
                .ok_or(Error::Dependency("堆栈样本引用未声明线程"))?;
            let mut callchain = Vec::with_capacity(raw.chain.len());
            for entry in raw.chain {
                check()?;
                let file = self
                    .files
                    .get(&entry.file)
                    .ok_or(Error::Dependency("堆栈样本引用未声明库"))?;
                output_budget = output_budget
                    .checked_add(
                        128 + file.path.len()
                            + entry
                                .symbol
                                .and_then(|id| file.symbols.get(id as usize))
                                .map_or(0, String::len),
                    )
                    .filter(|n| *n <= 32 * 1024 * 1024)
                    .ok_or(Error::TooLarge)?;
                let symbol = entry
                    .symbol
                    .map(|id| {
                        file.symbols
                            .get(id as usize)
                            .cloned()
                            .ok_or(Error::Dependency("堆栈样本符号编号越界"))
                    })
                    .transpose()?;
                callchain.push(StackFrame {
                    file: Some(file.path.clone()),
                    symbol,
                    address: format!("0x{:x}", entry.address),
                    execution_type: ["native", "interpreted_jvm", "jit_jvm", "art"]
                        [entry.execution as usize]
                        .into(),
                });
            }
            samples.push(StackSample {
                time_ns: raw.time.to_string(),
                thread_id: raw.thread,
                process_id: Some(thread.process),
                thread_name: Some(thread.name.clone()),
                event_count: raw.count.to_string(),
                event_type: Some(
                    events
                        .get(raw.event as usize)
                        .cloned()
                        .ok_or(Error::Dependency("堆栈样本事件编号越界"))?,
                ),
                callchain,
                unwinding: raw.unwind,
            });
        }
        check()?;
        Ok(Report {
            samples,
            lost_count,
            reported_sample_count,
            events,
        })
    }
}
fn sort_samples(
    samples: Vec<sample::RawSample>,
    check: Check<'_>,
) -> Result<Vec<sample::RawSample>> {
    let length = samples.len();
    let mut source: Vec<Option<sample::RawSample>> = samples.into_iter().map(Some).collect();
    let mut target: Vec<Option<sample::RawSample>> = (0..length).map(|_| None).collect();
    let mut width = 1usize;
    while width < length {
        for begin in (0..length).step_by(width * 2) {
            let middle = (begin + width).min(length);
            let end = (middle + width).min(length);
            let (mut left, mut right) = (begin, middle);
            for slot in target.iter_mut().take(end).skip(begin) {
                check()?;
                let take_left = right == end
                    || (left < middle
                        && source[left].as_ref().map(|s| s.time)
                            <= source[right].as_ref().map(|s| s.time));
                let index = if take_left {
                    let index = left;
                    left += 1;
                    index
                } else {
                    let index = right;
                    right += 1;
                    index
                };
                *slot = source[index].take();
            }
        }
        std::mem::swap(&mut source, &mut target);
        width = width.checked_mul(2).ok_or(Error::TooLarge)?;
    }
    source
        .into_iter()
        .map(|value| {
            check()?;
            value.ok_or(Error::Dependency("堆栈排序记录缺失"))
        })
        .collect()
}

pub(crate) fn parse(bytes: &[u8], check: Check<'_>) -> Result<Report> {
    check()?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(Error::TooLarge);
    }
    if bytes.get(..12) != Some(b"SIMPLEPERF\x01\x00") {
        return Err(Error::Dependency("堆栈报告标识或版本未知"));
    }
    let mut state = State {
        samples: Vec::new(),
        files: BTreeMap::new(),
        threads: BTreeMap::new(),
        events: None,
        lost: None,
        chain_count: 0,
    };
    let mut offset = 12usize;
    let mut count = 0usize;
    loop {
        check()?;
        let end = offset
            .checked_add(4)
            .filter(|v| *v <= bytes.len())
            .ok_or(Error::Dependency("堆栈报告缺少长度或终止记录"))?;
        let size = u32::from_le_bytes(
            bytes[offset..end]
                .try_into()
                .map_err(|_| Error::Dependency("堆栈报告长度无效"))?,
        ) as usize;
        offset = end;
        if size == 0 {
            if offset != bytes.len() {
                return Err(Error::Dependency("堆栈报告存在终止后的字节"));
            }
            break;
        }
        count += 1;
        if count > 200000 || size > 16 * 1024 * 1024 {
            return Err(Error::TooLarge);
        }
        let end = offset
            .checked_add(size)
            .filter(|v| *v <= bytes.len())
            .ok_or(Error::Dependency("堆栈报告记录长度越界"))?;
        state.record(&bytes[offset..end], check)?;
        offset = end;
    }
    state.resolve(check)
}
#[cfg(test)]
mod tests;
