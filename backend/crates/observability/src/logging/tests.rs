use super::*;
use std::sync::{Condvar, Mutex, mpsc};

fn config(directory: std::path::PathBuf) -> LogConfig {
    LogConfig {
        directory,
        queue_capacity: 16,
        retained_files: 3,
        level: tracing::level_filters::LevelFilter::TRACE,
    }
}

#[test]
fn json_lines_filter_size_limit_and_exit_flush() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = LogRuntime::open(config(directory.path().into())).unwrap();
    let metrics = runtime.metrics();
    tracing::subscriber::with_default(runtime.subscriber(), || {
        let span = tracing::info_span!(target: "deviceforge_test", "请求", log_id = "关联示例");
        let _entered = span.enter();
        tracing::info!(target: "deviceforge_test", job_id = "任务示例", "正确记录");
        tracing::info!(target: "external_sdk", secret = "不可进入日志的测试哨兵", "外部 SDK 输出");
        tracing::info!(target: "deviceforge_test", oversized = %"x".repeat(20000), "超大事件");
    });
    drop(runtime);
    let path = std::fs::read_dir(directory.path())
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let text = std::fs::read_to_string(path).unwrap();
    let values: Vec<serde_json::Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(values.len(), 1);
    assert!(text.contains("关联示例") && text.contains("任务示例"));
    assert!(!text.contains("测试哨兵") && !text.contains("超大事件"));
    assert_eq!(metrics.snapshot().oversized_records, 1);
    assert_eq!(metrics.snapshot().written_bytes, text.len() as u64);
}

struct Blocked {
    ready: mpsc::Sender<()>,
    release: Arc<(Mutex<bool>, Condvar)>,
}
impl Write for Blocked {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let _ = self.ready.send(());
        let (lock, condition) = &*self.release;
        let mut released = lock.lock().unwrap();
        while !*released {
            released = condition.wait(released).unwrap();
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
#[test]
fn full_queue_drops_records_without_waiting_for_disk() {
    let release = Arc::new((Mutex::new(false), Condvar::new()));
    let (ready, started) = mpsc::channel();
    let mut configuration = config("unused".into());
    configuration.queue_capacity = 1;
    let runtime = LogRuntime::with_writer(
        configuration,
        Blocked {
            ready,
            release: release.clone(),
        },
    );
    let metrics = runtime.metrics();
    tracing::subscriber::with_default(runtime.subscriber(), || {
        tracing::info!(target: "deviceforge_test", "第一条");
        started
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        for _ in 0..1000 {
            tracing::info!(target: "deviceforge_test", "队列压力");
        }
    });
    let dropped = metrics.snapshot().dropped_records;
    let (lock, condition) = &*release;
    *lock.lock().unwrap() = true;
    condition.notify_all();
    drop(runtime);
    assert!(dropped >= 999);
}

struct Broken;
impl Write for Broken {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(io::Error::other("模拟磁盘错误"))
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
#[test]
fn disk_errors_are_observable() {
    let runtime = LogRuntime::with_writer(config("unused".into()), Broken);
    let metrics = runtime.metrics();
    tracing::subscriber::with_default(
        runtime.subscriber(),
        || tracing::info!(target: "deviceforge_test", "写入失败"),
    );
    drop(runtime);
    assert!(metrics.snapshot().write_errors > 0);
}

#[test]
fn retention_preserves_unrelated_files_and_invalid_config_is_rejected() {
    let directory = tempfile::tempdir().unwrap();
    for day in 1..=5 {
        std::fs::write(
            directory
                .path()
                .join(format!("deviceforge.2020-01-{day:02}.jsonl")),
            b"{}\n",
        )
        .unwrap();
    }
    std::fs::write(directory.path().join("unrelated.jsonl"), "保留".as_bytes()).unwrap();
    drop(LogRuntime::open(config(directory.path().into())).unwrap());
    let count = std::fs::read_dir(directory.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("deviceforge.")
        })
        .count();
    assert!(count <= 3);
    assert!(directory.path().join("unrelated.jsonl").exists());
    let mut invalid = config(directory.path().into());
    invalid.queue_capacity = 0;
    assert!(LogRuntime::open(invalid).is_err());
}

#[tokio::test]
async fn parallel_tasks_keep_their_origin_context() {
    let left = crate::LogContext::default();
    let right = crate::LogContext::default();
    let run = |context: crate::LogContext| async move {
        let expected = context.log_id.clone();
        context
            .scope(async {
                tokio::spawn(crate::LogContext::propagate(async {
                    tokio::task::yield_now().await;
                    crate::LogContext::current().unwrap().log_id
                }))
                .await
                .unwrap()
            })
            .await
            == expected
    };
    let (a, b) = tokio::join!(run(left), run(right));
    assert!(a && b);
    assert!(crate::LogContext::current().is_none());
}
