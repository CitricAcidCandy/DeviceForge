use super::*;
use apk_domain::performance::*;
use std::{path::PathBuf, sync::OnceLock};
fn target(mode: &str) -> (tempfile::TempDir, PerformanceTarget) {
    let directory = tempfile::Builder::new()
        .prefix(&format!("{mode}."))
        .tempdir()
        .unwrap();
    let target = PerformanceTarget {
        device_id: directory
            .path()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
        package: "com.example.app".into(),
    };
    (directory, target)
}
fn tool() -> &'static str {
    static TOOL: OnceLock<(tempfile::TempDir, String)> = OnceLock::new();
    &TOOL
        .get_or_init(|| {
            let directory = tempfile::tempdir().unwrap();
            let binary = directory.path().join(if cfg!(windows) {
                "performance.exe"
            } else {
                "performance"
            });
            let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("src/performance/fixtures/performance-tool.rs");
            let output = std::process::Command::new("rustc")
                .arg(source)
                .arg("-o")
                .arg(&binary)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            (directory, binary.to_string_lossy().into_owned())
        })
        .1
}
fn raw(ticks: u64, total: u64) -> RawPerformance {
    RawPerformance {
        captured_at: 100,
        pid: 123,
        process_start_ticks: 900,
        process_ticks: ticks,
        system_ticks: total,
        logical_cpus: 2,
        pss_kib: 2048,
        rss_kib: Some(4096),
        frame_window: None,
    }
}
fn session(id: String) -> PerformanceSession {
    PerformanceSession {
        source: None,
        id,
        request: PerformanceStart {
            target: PerformanceTarget {
                device_id: "device".into(),
                package: "com.example.app".into(),
            },
            interval_ms: 1000,
            duration_secs: 10,
        },
        state: PerformanceState::Running,
        revision: 0,
        samples: 0,
        started_at: 100,
        updated_at: 100,
        error: None,
    }
}
#[test]
fn counters_and_memory_require_complete_unambiguous_output() {
    assert_eq!(
        parse::system("cpu 10 20 30 40 50 60 70 80 900 900\ncpu0 1\ncpu1 1").unwrap(),
        (360, 2)
    );
    for value in [
        "cpu 0 0 0 0\ncpu0 1",
        "cpu 1 2 3 4",
        "cpu 1 2 3 4\ncpu0 1\ncpu0 1",
        "cpu 1 a 3 4\ncpu0 1",
    ] {
        assert!(parse::system(value).is_err());
    }
    assert!(parse::pid("123 456").is_err());
    assert!(parse::pid("0").is_err());
    assert!(parse::process("123 (name) S 0", 123).is_err());
    assert_eq!(
        parse::memory(
            "** MEMINFO in pid 123 [app] **\n TOTAL 2048 1 2\nTOTAL PSS: 2048 TOTAL RSS: 4096",
            123
        )
        .unwrap(),
        (2048, Some(4096))
    );
    for value in [
        "TOTAL PSS: 10",
        "** MEMINFO in pid 124 [app] **\nTOTAL PSS: 10",
        "** MEMINFO in pid 123 [app] **\nTOTAL PSS: 10\nTOTAL PSS: 11",
    ] {
        assert!(parse::memory(value, 123).is_err());
    }
    let old = raw(100, 1000);
    let current = raw(110, 1100);
    let reading = PerformanceReading::from_raw(2, &current, Some(&old));
    assert_eq!(reading.cpu_share_percent, Some(10.0));
    assert_eq!(reading.cpu_core_percent, Some(20.0));
    let mut restarted = current.clone();
    restarted.process_start_ticks += 1;
    assert!(
        PerformanceReading::from_raw(3, &restarted, Some(&old))
            .cpu_share_percent
            .is_none()
    );
    assert!(
        PerformanceReading::from_raw(3, &raw(90, 1100), Some(&old))
            .cpu_share_percent
            .is_none()
    );
    assert!(
        PerformanceReading::from_raw(3, &raw(500, 1100), Some(&old))
            .cpu_share_percent
            .is_none()
    );
}
#[tokio::test]
async fn real_process_probe_validates_identity_and_counter_deltas() {
    let (_directory, target) = target("ok");
    let probe = AndroidPerformance { adb: tool().into() };
    let first = probe
        .sample(&target, CancellationToken::new())
        .await
        .unwrap();
    let second = probe
        .sample(&target, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(first.process_ticks, 105);
    assert_eq!(first.system_ticks, 1000);
    assert_eq!(first.pss_kib, 2048);
    assert_eq!(
        PerformanceReading::from_raw(2, &second, Some(&first)).cpu_share_percent,
        Some(10.0)
    );
    for mode in ["denied", "exit"] {
        let (_directory, target) = self::target(mode);
        assert!(matches!(
            probe.sample(&target, CancellationToken::new()).await,
            Err(Error::Dependency(_))
        ));
    }
    let (_directory, target) = self::target("slow");
    let cancel = CancellationToken::new();
    let signal = cancel.clone();
    let (result, ()) = tokio::join!(probe.sample(&target, cancel), async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        signal.cancel();
    });
    assert!(matches!(result, Err(Error::Cancelled)));
}
#[test]
fn durable_sessions_reject_late_samples_reset_baselines_and_recover_all_pages() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("performance.db");
    let store = store::SqlitePerformance::open(&path).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    store.create(session(id.clone())).unwrap();
    assert!(store.append(&id, 0, raw(100, 1000)).unwrap());
    assert!(store.append(&id, 0, raw(110, 1100)).unwrap());
    let page = store.samples(&id, 0, 1).unwrap();
    assert_eq!(page.next_after, 1);
    assert!(page.readings[0].cpu_share_percent.is_none());
    assert_eq!(
        store.samples(&id, 1, 100).unwrap().readings[0].cpu_share_percent,
        Some(10.0)
    );
    let paused = store
        .transition(&id, 0, PerformanceState::Paused, None)
        .unwrap();
    assert!(!store.append(&id, 0, raw(120, 1200)).unwrap());
    assert!(matches!(
        store.transition(&id, 0, PerformanceState::Running, None),
        Err(Error::Conflict(_))
    ));
    let resumed = store
        .transition(&id, paused.revision, PerformanceState::Running, None)
        .unwrap();
    assert!(store.append(&id, resumed.revision, raw(120, 1200)).unwrap());
    assert!(
        store.samples(&id, 2, 100).unwrap().readings[0]
            .cpu_share_percent
            .is_none()
    );
    let stopped = store
        .transition(&id, resumed.revision, PerformanceState::Stopped, None)
        .unwrap();
    assert!(
        store
            .transition(&id, stopped.revision, PerformanceState::Running, None)
            .is_err()
    );
    for _ in 0..205 {
        store
            .create(session(uuid::Uuid::new_v4().to_string()))
            .unwrap();
    }
    drop(store);
    let store = store::SqlitePerformance::open(path).unwrap();
    assert_eq!(store.recover().unwrap(), 205);
    assert_eq!(store.recover().unwrap(), 0);
    assert_eq!(store.get(&id).unwrap().state, PerformanceState::Stopped);
    let mut cursor = None;
    let mut count = 0;
    loop {
        let page = store.list(cursor.as_deref(), 50).unwrap();
        count += page.sessions.len();
        if page.sessions.is_empty() {
            break;
        }
        cursor = page.next_after_id;
    }
    assert_eq!(count, 206);
    assert!(store.samples(&id, u64::MAX, 1).is_err());
    assert!(store.list(None, 101).is_err());
}
