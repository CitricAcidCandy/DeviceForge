//! 使用生产格式化与有界队列测量本机提交耗时；不代表生产磁盘与网络性能。
use deviceforge_observability::{LogConfig, LogRuntime};
use std::time::Instant;
use tracing::level_filters::LevelFilter;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let runtime = LogRuntime::open(LogConfig {
        directory: directory.path().into(),
        queue_capacity: 8192,
        retained_files: 14,
        level: LevelFilter::INFO,
    })?;
    let metrics = runtime.metrics();
    let dispatch = tracing::Dispatch::new(runtime.subscriber());
    let started = Instant::now();
    let mut times = std::thread::scope(|scope| {
        let workers: Vec<_> = (0..4).map(|worker| {
            let dispatch = dispatch.clone();
            scope.spawn(move || {
                let _subscriber = tracing::dispatcher::set_default(&dispatch);
                let span = tracing::info_span!(target: "deviceforge_logging_bench", "性能测量", log_id = "00000000-0000-4000-8000-000000000001", worker);
                let _entered = span.enter();
                (0..7500).map(|index| {
                    let before = Instant::now();
                    tracing::info!(target: "deviceforge_logging_bench", index, status = 200, elapsed_us = 20_u64, "请求已完成");
                    before.elapsed().as_nanos() as u64
                }).collect::<Vec<_>>()
            })
        }).collect();
        workers
            .into_iter()
            .flat_map(|worker| worker.join().expect("测量线程应正常结束"))
            .collect::<Vec<_>>()
    });
    let submitted_elapsed = started.elapsed();
    let flush_started = Instant::now();
    drop(runtime);
    let flush_elapsed = flush_started.elapsed();
    let total_elapsed = started.elapsed();
    times.sort_unstable();
    let stats = metrics.snapshot();
    let persisted = std::fs::read_dir(directory.path())?.try_fold(0_usize, |total, item| {
        Ok::<_, std::io::Error>(total + std::fs::read_to_string(item?.path())?.lines().count())
    })?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
        "scope":"本机四线程突发饱和；INFO JSONL；生产格式化与有界队列；本机临时目录；分别测量提交和退出刷新",
        "profile":if cfg!(debug_assertions) { "debug" } else { "release" },
        "platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,
        "attempted_events":times.len(),"submit_elapsed_ms":submitted_elapsed.as_secs_f64()*1000.0,
        "submit_attempts_per_second":times.len() as f64/submitted_elapsed.as_secs_f64(),
        "flush_elapsed_ms":flush_elapsed.as_secs_f64()*1000.0,
        "persisted_records":persisted,"persisted_records_per_second":persisted as f64/total_elapsed.as_secs_f64(),
            "submit_p50_us":times[times.len()/2] as f64/1000.0,
            "submit_p95_us":times[times.len()*95/100] as f64/1000.0,
            "submit_p99_us":times[times.len()*99/100] as f64/1000.0,
            "log_stats":stats
        }))?
    );
    Ok(())
}
