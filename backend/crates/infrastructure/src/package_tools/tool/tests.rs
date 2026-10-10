use super::*;
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, Instant},
};

fn command() -> ToolCommand {
    static TOOL: OnceLock<(tempfile::TempDir, String)> = OnceLock::new();
    let (_, path) = TOOL.get_or_init(|| {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(if cfg!(windows) {
            "controlled.exe"
        } else {
            "controlled"
        });
        let source =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/package_tools/tool/fixture.rs");
        let result = std::process::Command::new("rustc")
            .arg(source)
            .arg("-o")
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        (directory, path.to_string_lossy().into_owned())
    });
    ToolCommand::executable(path.clone())
}

async fn ready(path: &Path) {
    let start = Instant::now();
    while !path.exists() {
        assert!(start.elapsed() < Duration::from_secs(5), "真实工具未就绪");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}
struct Release(PathBuf);
impl Drop for Release {
    fn drop(&mut self) {
        let _ = std::fs::write(&self.0, "结束".as_bytes());
    }
}

fn start(
    tracker: Arc<Tracker>,
    directory: &Path,
    cancel: CancellationToken,
) -> tokio::task::JoinHandle<Result<String>> {
    let command = command();
    let args = vec![
        "ready".into(),
        directory.join("ready").to_string_lossy().into_owned(),
        directory.join("release").to_string_lossy().into_owned(),
    ];
    let deadline = (tokio::time::Instant::now() + Duration::from_secs(180)).into_std();
    tokio::spawn(async move { tracker.output(&command, args, cancel, Some(deadline)).await })
}

#[tokio::test]
async fn explicit_deadline_allows_real_tool_past_compatibility_limit() {
    let directory = tempfile::tempdir().unwrap();
    let release = Release(directory.path().join("release"));
    let tracker = Arc::new(Tracker::default());
    let task = start(tracker.clone(), directory.path(), CancellationToken::new());
    ready(&directory.path().join("ready")).await;
    assert!(!tracker.unresolved());
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(121)).await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    let ended_early = task.is_finished();
    tokio::time::resume();
    drop(release);
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
    assert!(!ended_early, "原180秒截止点不能被兼容120秒截短");
    assert_eq!(result.unwrap(), "完成");
    assert!(!tracker.unresolved());
}

#[tokio::test]
async fn dropped_tool_wait_remains_unconfirmed_after_later_success() {
    let directory = tempfile::tempdir().unwrap();
    let _release = Release(directory.path().join("release"));
    let tracker = Arc::new(Tracker::default());
    let task = start(tracker.clone(), directory.path(), CancellationToken::new());
    ready(&directory.path().join("ready")).await;
    assert!(!tracker.unresolved());
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(tracker.unresolved());
    assert_eq!(
        tracker
            .output(&command(), vec![], CancellationToken::new(), None)
            .await
            .unwrap(),
        "完成"
    );
    assert!(tracker.unresolved());
}

#[tokio::test]
async fn confirmed_cancellation_and_nonzero_exit_do_not_mark_cleanup_failure() {
    let directory = tempfile::tempdir().unwrap();
    let _release = Release(directory.path().join("release"));
    let tracker = Arc::new(Tracker::default());
    let cancel = CancellationToken::new();
    let task = start(tracker.clone(), directory.path(), cancel.clone());
    ready(&directory.path().join("ready")).await;
    cancel.cancel();
    assert!(matches!(task.await.unwrap(), Err(Error::Cancelled)));
    assert!(!tracker.unresolved());
    assert!(
        matches!(tracker.output(&command(), vec!["fail".into()], CancellationToken::new(), None).await,
        Err(Error::Dependency(message)) if message == "工具拒绝")
    );
    assert!(!tracker.unresolved());
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let absent = ToolCommand::executable("not-a-program-must-not-start".into());
    assert!(matches!(
        tracker.output(&absent, vec![], cancelled, None).await,
        Err(Error::Cancelled)
    ));
    assert!(!tracker.unresolved());
}
