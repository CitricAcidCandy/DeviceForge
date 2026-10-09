use apk_domain::{
    Error, Executor,
    performance::{PerformanceProbe, PerformanceReading, PerformanceStart, PerformanceTarget},
};
use apk_infrastructure::{
    performance::store::SqlitePerformance, performance_plugin::PluginPerformance,
    plugins::ProcessPlugin,
};
use apk_plugin_sdk::{ARTIFACT_PROTOCOL_VERSION, Contribution, Manifest, PerformanceAccess};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
fn manifest(mode: &str, fps: bool) -> Manifest {
    Manifest {
        id: "performance_demo".into(),
        version: "0.1.0".into(),
        protocol_version: ARTIFACT_PROTOCOL_VERSION,
        executable: env!("CARGO_BIN_EXE_deviceforge-performance-demo-plugin").into(),
        args: if mode.is_empty() {
            Vec::new()
        } else {
            vec![mode.into()]
        },
        artifacts: None,
        devices: None,
        performance: Some(PerformanceAccess {
            sample_operation: "sample".into(),
            fps,
        }),
        operations: vec![Contribution {
            name: "sample".into(),
            title: "合成性能协议示例".into(),
            input_schema: json!({"type":"object","properties":{"device_id":{"type":"string"},"package":{"type":"string"}},"required":["device_id","package"],"additionalProperties":false}),
        }],
    }
}
fn probe(mode: &str, fps: bool) -> PluginPerformance {
    PluginPerformance::new(Arc::new(ProcessPlugin::new(manifest(mode, fps)).unwrap())).unwrap()
}
fn target() -> PerformanceTarget {
    PerformanceTarget {
        device_id: "emulator-5554".into(),
        package: "com.example.app".into(),
    }
}
#[tokio::test]
async fn real_plugin_sample_maps_public_sdk_to_domain_and_persists_fps() {
    let probe = probe("", true);
    assert_eq!(probe.capabilities().source, "plugin.performance_demo");
    assert!(probe.capabilities().fps);
    let raw = probe
        .sample(&target(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(raw.pss_kib, 2048);
    let reading = PerformanceReading::from_raw(1, &raw, None);
    assert_eq!(reading.fps, Some(60.0));
    assert_eq!(reading.frame_window.unwrap().source, "synthetic_demo");
    let directory = tempfile::tempdir().unwrap();
    let service = apk_application::performance::PerformanceService::new(
        Arc::new(probe),
        Arc::new(SqlitePerformance::open(directory.path().join("performance.db")).unwrap()),
        1,
    )
    .unwrap();
    let session = service
        .start(
            PerformanceStart {
                target: target(),
                interval_ms: 1000,
                duration_secs: 10,
            },
            CancellationToken::new(),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while service.get(session.id.clone()).await.unwrap().samples == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let page = service
        .samples(apk_domain::performance::PerformanceSamples {
            session_id: session.id.clone(),
            after: 0,
            limit: 1,
        })
        .await
        .unwrap();
    assert_eq!(page.readings[0].fps, Some(60.0));
    let capability = service
        .execute(
            "android.performance.capabilities",
            json!({}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(capability["fps"], true);
    assert!(
        capability["metrics"]
            .as_array()
            .unwrap()
            .contains(&json!("fps"))
    );
    service.shutdown().await.unwrap();
}
#[tokio::test]
async fn malformed_stale_undeclared_and_cancelled_plugin_samples_are_rejected() {
    for mode in [
        "--bad-window",
        "--bad-source",
        "--bad-frames",
        "--bad-pid",
        "--stale",
        "--future",
        "--unknown",
        "--error",
    ] {
        assert!(
            matches!(
                probe(mode, true)
                    .sample(&target(), CancellationToken::new())
                    .await,
                Err(Error::Dependency(_))
            ),
            "未拒绝模式：{mode}"
        );
    }
    assert!(matches!(
        probe("", false)
            .sample(&target(), CancellationToken::new())
            .await,
        Err(Error::Dependency(_))
    ));
    assert!(
        probe("--no-fps", true)
            .sample(&target(), CancellationToken::new())
            .await
            .unwrap()
            .frame_window
            .is_none()
    );
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(matches!(
        probe("", true).sample(&target(), cancelled).await,
        Err(Error::Cancelled)
    ));
    let slow = probe("--slow", true);
    let cancel = CancellationToken::new();
    let signal = cancel.clone();
    let slow_target = target();
    let (result, ()) = tokio::join!(slow.sample(&slow_target, cancel), async {
        tokio::time::sleep(Duration::from_millis(100)).await;
        signal.cancel();
    });
    assert!(matches!(result, Err(Error::Cancelled)));
}
#[test]
fn manifest_capability_and_schema_are_checked_before_execution() {
    let mut value = manifest("", true);
    value.protocol_version = 1;
    assert!(ProcessPlugin::new(value).is_err());
    let mut value = manifest("", true);
    value.performance.as_mut().unwrap().sample_operation = "missing".into();
    assert!(ProcessPlugin::new(value).is_err());
    let mut value = manifest("", true);
    value.artifacts = Some(apk_plugin_sdk::ArtifactAccess {
        input_fields: vec![],
        outputs: true,
    });
    assert!(ProcessPlugin::new(value).is_err());
    let mut value = manifest("", true);
    value.performance = None;
    assert!(PluginPerformance::new(Arc::new(ProcessPlugin::new(value).unwrap())).is_err());
    let mut value = manifest("", true);
    value.operations[0].input_schema = json!({"type":"invalid"});
    assert!(PluginPerformance::new(Arc::new(ProcessPlugin::new(value).unwrap())).is_err());
    let parsed: apk_domain::performance::RawPerformance = serde_json::from_value(json!({"captured_at":1,"pid":123,"process_start_ticks":900,"process_ticks":10,"system_ticks":100,"logical_cpus":2,"pss_kib":2048,"rss_kib":null})).unwrap();
    assert!(parsed.frame_window.is_none());
}

#[tokio::test]
async fn input_schema_and_sample_timeout_apply_to_direct_probe_calls() {
    let mut value = manifest("", true);
    value.operations[0].input_schema = json!({"type":"object","properties":{"device_id":{"const":"other"},"package":{"type":"string"}},"required":["device_id","package"],"additionalProperties":false});
    let adapter = PluginPerformance::new(Arc::new(ProcessPlugin::new(value).unwrap())).unwrap();
    assert!(matches!(
        adapter.sample(&target(), CancellationToken::new()).await,
        Err(Error::Invalid(_))
    ));
    let started = tokio::time::Instant::now();
    assert!(matches!(
        probe("--slow", true)
            .sample(&target(), CancellationToken::new())
            .await,
        Err(Error::Timeout)
    ));
    assert!(started.elapsed() < Duration::from_secs(15));
    let mut value = manifest("", true);
    value.operations[0].input_schema = json!({"$ref":"file:///forbidden"});
    assert!(PluginPerformance::new(Arc::new(ProcessPlugin::new(value).unwrap())).is_err());
}
