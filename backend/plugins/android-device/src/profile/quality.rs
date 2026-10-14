//! 调用栈质量纯汇总；缺失错误元数据不代表完整展开，采集合同不推断目标架构。
use super::report::Report;
use crate::{Error, Result};
use serde::Serialize;
use std::collections::BTreeMap;

const SAMPLE_LIMIT: usize = 100000;
const FRAME_LIMIT: usize = 1000000;
const DEPTH_LIMIT: usize = 256;
const ERROR_PAIR_LIMIT: usize = 4096;
type Check<'a> = &'a (dyn Fn() -> Result<()> + Sync);

#[derive(Debug, Serialize)]
pub(crate) struct Quality {
    format_version: u32,
    capture: Capture,
    counts: Counts,
    depth_histogram: Vec<DepthCount>,
    unwinding_error_histogram: Vec<ErrorCount>,
    architecture: Architecture,
    symbolication: Symbolication,
}
#[derive(Debug, Serialize)]
struct Capture {
    mode: &'static str,
    event: &'static str,
    frequency_hz: u32,
    clock: &'static str,
    report_filter: &'static str,
    remove_gaps: u32,
}
#[derive(Debug, Default, Serialize)]
struct Counts {
    reported_sample_count: String,
    parsed_sample_count: String,
    lost_count: String,
    callchain_frame_count: usize,
    empty_callchain_sample_count: usize,
    single_frame_sample_count: usize,
    max_callchain_depth: usize,
    unwinding_error_sample_count: usize,
    unwinding_without_error_sample_count: usize,
    unwinding_metadata_missing_sample_count: usize,
    missing_symbol_frame_count: usize,
    missing_symbol_sample_count: usize,
}
#[derive(Debug, Serialize)]
struct DepthCount {
    depth: usize,
    count: usize,
}
#[derive(Debug, Serialize)]
struct ErrorCount {
    raw_error_code: Option<u32>,
    error_code: Option<u32>,
    count: usize,
}
#[derive(Debug, Serialize)]
struct Architecture {
    status: &'static str,
    device_arch: Option<&'static str>,
    target_process_arch: Option<&'static str>,
    reason: &'static str,
}
#[derive(Debug, Serialize)]
struct Symbolication {
    status: &'static str,
    build_id_status: &'static str,
    reason: &'static str,
}

pub(crate) fn summarize(report: &Report, check: Check<'_>) -> Result<Quality> {
    check()?;
    if report.samples.len() > SAMPLE_LIMIT {
        return Err(Error::TooLarge);
    }
    let mut counts = Counts {
        reported_sample_count: report.reported_sample_count.to_string(),
        parsed_sample_count: report.samples.len().to_string(),
        lost_count: report.lost_count.to_string(),
        ..Counts::default()
    };
    let mut depths = BTreeMap::new();
    let mut errors = BTreeMap::new();
    for sample in &report.samples {
        check()?;
        let depth = sample.callchain.len();
        if depth > DEPTH_LIMIT {
            return Err(Error::TooLarge);
        }
        counts.callchain_frame_count = counts
            .callchain_frame_count
            .checked_add(depth)
            .filter(|count| *count <= FRAME_LIMIT)
            .ok_or(Error::TooLarge)?;
        *depths.entry(depth).or_insert(0usize) += 1;
        counts.empty_callchain_sample_count += usize::from(depth == 0);
        counts.single_frame_sample_count += usize::from(depth == 1);
        counts.max_callchain_depth = counts.max_callchain_depth.max(depth);
        let mut missing_symbol = false;
        for frame in &sample.callchain {
            check()?;
            if frame.symbol.as_ref().is_none_or(String::is_empty) {
                counts.missing_symbol_frame_count += 1;
                missing_symbol = true;
            }
        }
        counts.missing_symbol_sample_count += usize::from(missing_symbol);
        match sample.unwinding.as_ref() {
            None => counts.unwinding_metadata_missing_sample_count += 1,
            Some(unwind)
                if unwind.raw_error_code.is_some_and(|code| code != 0)
                    || unwind.error_code.is_some_and(|code| code != 0) =>
            {
                counts.unwinding_error_sample_count += 1;
                let pair = (unwind.raw_error_code, unwind.error_code);
                if errors.len() >= ERROR_PAIR_LIMIT && !errors.contains_key(&pair) {
                    return Err(Error::TooLarge);
                }
                *errors.entry(pair).or_insert(0usize) += 1;
            }
            Some(_) => counts.unwinding_without_error_sample_count += 1,
        }
    }
    check()?;
    Ok(Quality {
        format_version: 1,
        capture: Capture {
            mode: "dwarf",
            event: "cpu-clock",
            frequency_hz: 99,
            clock: "boottime",
            report_filter: "disabled",
            remove_gaps: 0,
        },
        counts,
        depth_histogram: depths
            .into_iter()
            .map(|(depth, count)| DepthCount { depth, count })
            .collect(),
        unwinding_error_histogram: errors
            .into_iter()
            .map(|((raw_error_code, error_code), count)| ErrorCount {
                raw_error_code,
                error_code,
                count,
            })
            .collect(),
        architecture: Architecture {
            status: "unavailable",
            device_arch: None,
            target_process_arch: None,
            reason: "官方报告protobuf未提供设备或目标进程架构，设备ABI列表不能代替目标ELF身份",
        },
        symbolication: Symbolication {
            status: "reported_symbols_only",
            build_id_status: "unavailable",
            reason: "官方报告protobuf未提供Build ID，本轮仅保存报告已有符号",
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::report::{StackFrame, StackSample, model::Unwinding};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn sample(symbols: &[Option<&str>], unwind: Option<(Option<u32>, Option<u32>)>) -> StackSample {
        StackSample {
            time_ns: "1".into(),
            thread_id: 1,
            process_id: Some(1),
            thread_name: None,
            event_count: "1".into(),
            event_type: Some("cpu-clock".into()),
            callchain: symbols
                .iter()
                .map(|symbol| StackFrame {
                    file: None,
                    symbol: symbol.map(str::to_owned),
                    address: "0x1".into(),
                    execution_type: "native".into(),
                })
                .collect(),
            unwinding: unwind.map(|(raw_error_code, error_code)| Unwinding {
                raw_error_code,
                error_code,
                error_address: None,
            }),
        }
    }

    fn report(samples: Vec<StackSample>) -> Report {
        Report {
            reported_sample_count: samples.len() as u64,
            samples,
            lost_count: u64::MAX,
            events: vec!["cpu-clock".into()],
        }
    }
    #[test]
    fn quality_preserves_error_codes_and_distinguishes_missing_metadata() {
        let source = report(vec![
            sample(&[], None),
            sample(&[None], Some((Some(2), Some(4)))),
            sample(&[Some(""), Some("f")], Some((None, Some(0)))),
            sample(&[Some("f")], Some((Some(0), None))),
            sample(&[Some("f")], Some((None, None))),
            sample(&[Some("f")], Some((Some(u32::MAX), Some(0)))),
            sample(&[Some("f")], Some((Some(2), Some(4)))),
        ]);
        let quality = summarize(&source, &|| Ok(())).unwrap();
        let counts = &quality.counts;
        assert_eq!(counts.reported_sample_count, "7");
        assert_eq!(counts.parsed_sample_count, "7");
        assert_eq!(counts.lost_count, u64::MAX.to_string());
        assert_eq!(counts.callchain_frame_count, 7);
        assert_eq!(counts.empty_callchain_sample_count, 1);
        assert_eq!(counts.single_frame_sample_count, 5);
        assert_eq!(counts.max_callchain_depth, 2);
        assert_eq!(counts.unwinding_error_sample_count, 3);
        assert_eq!(counts.unwinding_without_error_sample_count, 3);
        assert_eq!(counts.unwinding_metadata_missing_sample_count, 1);
        assert_eq!(counts.missing_symbol_frame_count, 2);
        assert_eq!(counts.missing_symbol_sample_count, 2);
        assert_eq!(quality.depth_histogram[0].depth, 0);
        assert_eq!(quality.depth_histogram[1].count, 5);
        assert_eq!(quality.unwinding_error_histogram[0].raw_error_code, Some(2));
        assert_eq!(quality.unwinding_error_histogram[0].error_code, Some(4));
        assert_eq!(quality.unwinding_error_histogram[0].count, 2);
        assert_eq!(
            quality.unwinding_error_histogram[1].raw_error_code,
            Some(u32::MAX)
        );
        assert_eq!(quality.architecture.target_process_arch, None);
        assert_eq!(quality.symbolication.build_id_status, "unavailable");
        assert_eq!(source.samples.len(), 7);
        let encoded = serde_json::to_value(&quality).unwrap();
        assert_eq!(encoded["capture"]["mode"], "dwarf");
        assert_eq!(encoded["capture"]["remove_gaps"], 0);
        assert_eq!(encoded["counts"]["lost_count"], u64::MAX.to_string());
    }

    #[test]
    fn quality_checks_cancellation_inside_callchains() {
        let source = report(vec![sample(&[Some("f"); 20], None)]);
        let calls = AtomicUsize::new(0);
        let result = summarize(&source, &|| {
            if calls.fetch_add(1, Ordering::Relaxed) == 5 {
                Err(Error::Cancelled)
            } else {
                Ok(())
            }
        });
        assert!(matches!(result, Err(Error::Cancelled)));
        assert_eq!(calls.load(Ordering::Relaxed), 6);
    }

    #[test]
    fn quality_rejects_excessive_depth_and_distinct_error_pairs() {
        assert!(matches!(
            summarize(&report(vec![sample(&[None; 257], None)]), &|| Ok(())),
            Err(Error::TooLarge)
        ));
        let samples = (0..=ERROR_PAIR_LIMIT)
            .map(|code| sample(&[], Some((Some(code as u32), Some(1)))))
            .collect();
        assert!(matches!(
            summarize(&report(samples), &|| Ok(())),
            Err(Error::TooLarge)
        ));
    }
}
