use apk_application::{Application, plugin_lifecycle::PluginService};
use apk_domain::{
    Error, Executor, JobStatus,
    artifacts::ArtifactStore,
    plugins::{PluginContribution, PluginState},
};
use apk_infrastructure::{
    artifacts::FileArtifacts, plugin_catalog::FilePluginCatalog, plugins::ProcessPlugin,
    store::SqliteStore,
};
use apk_plugin_sdk::{ArtifactAccess, Contribution, Manifest, Request, cooperative::*};
use futures_util::TryStreamExt;
use serde_json::json;
use std::{path::Path, process::Stdio, sync::Arc, time::Duration};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

const OPERATION: &str = "plugin.cooperative_demo.wait";

fn manifest(directory: &Path, mode: &str) -> Manifest {
    Manifest {
        configuration: None,
        recovery: None,
        id: "cooperative_demo".into(),
        version: "0.1.0".into(),
        protocol_version: COOPERATIVE_PROTOCOL_VERSION,
        executable: env!("CARGO_BIN_EXE_deviceforge-cooperative-demo-plugin").into(),
        args: vec![directory.to_string_lossy().into_owned(), mode.into()],
        performance: None,
        devices: None,
        sessions: None,
        artifacts: None,
        operations: vec![Contribution {
            name: "wait".into(),
            title: "合作等待".into(),
            input_schema: json!({"type":"object"}),
            execution: None,
        }],
    }
}

async fn marker(directory: &Path, name: &str) -> String {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(value) = tokio::fs::read_to_string(directory.join(name)).await
                && !value.is_empty()
            {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("真实插件应按时发布标记")
}

// 只观察本测试标记中的 PID，不终止其他进程。
async fn assert_exited(pid: &str) {
    let pid: u32 = pid.parse().expect("启动标记必须包含完整 PID");
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            #[cfg(windows)]
            let alive = {
                #[link(name = "kernel32")]
                unsafe extern "system" {
                    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
                    fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32)
                    -> u32;
                    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
                }
                // 只申请同步观察权限；句柄在同一作用域关闭。
                unsafe {
                    let handle = OpenProcess(0x00100000, 0, pid);
                    if handle.is_null() {
                        false
                    } else {
                        let pending = WaitForSingleObject(handle, 0) == 258;
                        CloseHandle(handle);
                        pending
                    }
                }
            };
            #[cfg(not(windows))]
            let alive = Path::new(&format!("/proc/{pid}")).exists();
            if !alive {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("本次插件子进程应已退出");
}

#[tokio::test]
async fn real_success_keeps_v2_result_wrapper_and_publishes_artifact() {
    let directory = tempfile::tempdir().unwrap();
    let artifacts = Arc::new(
        FileArtifacts::open(directory.path().join("artifacts"))
            .await
            .unwrap(),
    );
    for mode in ["", "artifact"] {
        let marks = directory
            .path()
            .join(if mode.is_empty() { "normal" } else { mode });
        tokio::fs::create_dir(&marks).await.unwrap();
        let mut manifest = manifest(&marks, mode);
        if mode == "artifact" {
            manifest.artifacts = Some(ArtifactAccess {
                input_fields: vec![],
                input_pointers: vec![],
                outputs: true,
            });
        }
        let plugin = ProcessPlugin::with_artifacts(manifest, artifacts.clone()).unwrap();
        let value = tokio::time::timeout(
            Duration::from_secs(5),
            plugin.execute(
                OPERATION,
                json!({"duration_ms":20}),
                CancellationToken::new(),
            ),
        )
        .await
        .expect("宿主收到响应后须关闭输入并完成真实进程退出")
        .unwrap();
        assert_eq!(value["result"]["waited_ms"], 20);
        assert_eq!(value["result"]["synthetic_demo"], true);
        assert!(!plugin.has_unresolved_resources());
        marker(&marks, "cleaned").await;
        assert_exited(&marker(&marks, "started").await).await;
        if mode == "artifact" {
            let id = value["artifacts"][0]["id"].as_str().unwrap();
            let (artifact, stream) = artifacts.download(id).await.unwrap();
            assert_eq!(artifact.filename, "wait.json");
            let bytes = stream
                .try_fold(Vec::new(), |mut bytes, chunk| async move {
                    bytes.extend_from_slice(&chunk);
                    Ok(bytes)
                })
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
                value["result"]
            );
        } else {
            assert_eq!(value["artifacts"], json!([]));
        }
    }
}

#[tokio::test]
async fn real_cancel_waits_for_cleanup_and_uncooperative_modes_remain_unresolved() {
    for mode in ["", "ignore", "failed"] {
        let directory = tempfile::tempdir().unwrap();
        let plugin = Arc::new(ProcessPlugin::new(manifest(directory.path(), mode)).unwrap());
        let cancel = CancellationToken::new();
        let task = {
            let plugin = plugin.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                plugin
                    .execute(OPERATION, json!({"duration_ms":60_000}), cancel)
                    .await
            })
        };
        let pid = marker(directory.path(), "started").await;
        let started = tokio::time::Instant::now();
        cancel.cancel();
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("合作窗口与终止必须落在应用层 2 秒预算内")
            .unwrap();
        if mode.is_empty() {
            assert!(matches!(result, Err(Error::Cancelled)));
            marker(directory.path(), "cancel_received").await;
            marker(directory.path(), "cleaned").await;
            assert!(started.elapsed() >= Duration::from_millis(40));
            assert!(!plugin.has_unresolved_resources());
        } else {
            assert!(matches!(result, Err(Error::CleanupFailed)));
            assert!(plugin.has_unresolved_resources());
            assert!(!directory.path().join("cleaned").exists());
            if mode == "failed" {
                marker(directory.path(), "cancel_received").await;
            }
        }
        assert_exited(&pid).await;
    }
}

#[tokio::test]
async fn real_sdk_cancel_response_closes_stdin_before_waiting_for_zero_exit() {
    let directory = tempfile::tempdir().unwrap();
    let plugin = Arc::new(ProcessPlugin::new(manifest(directory.path(), "sdk_stdin_eof")).unwrap());
    let cancel = CancellationToken::new();
    let task = {
        let plugin = plugin.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move {
            plugin
                .execute(OPERATION, json!({"duration_ms":60_000}), cancel)
                .await
        })
    };
    let pid = marker(directory.path(), "started").await;
    cancel.cancel();
    let result = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("保持原合作期限，响应后关闭输入才能取得零退出")
        .unwrap();
    assert!(matches!(result, Err(Error::Cancelled)), "{result:?}");
    assert!(!plugin.has_unresolved_resources());
    for name in [
        "cancel_received",
        "cleaned",
        "response_written",
        "stdin_eof",
    ] {
        marker(directory.path(), name).await;
    }
    assert_exited(&pid).await;
}

#[tokio::test]
async fn dropping_execution_future_kills_child_and_marks_unresolved() {
    let directory = tempfile::tempdir().unwrap();
    let plugin = Arc::new(ProcessPlugin::new(manifest(directory.path(), "")).unwrap());
    let task = {
        let plugin = plugin.clone();
        tokio::spawn(async move {
            plugin
                .execute(
                    OPERATION,
                    json!({"duration_ms":60_000}),
                    CancellationToken::new(),
                )
                .await
        })
    };
    let pid = marker(directory.path(), "started").await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(plugin.has_unresolved_resources());
    assert_exited(&pid).await;
    assert!(!directory.path().join("cleaned").exists());
}

#[tokio::test]
async fn real_stdin_eof_triggers_cleanup_and_rejects_late_success() {
    let directory = tempfile::tempdir().unwrap();
    let mut command =
        tokio::process::Command::new(env!("CARGO_BIN_EXE_deviceforge-cooperative-demo-plugin"));
    command
        .arg(directory.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("APK_API_TOKEN")
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let request = Request {
        protocol_version: 3,
        request_id: "eof-request".into(),
        operation: "wait".into(),
        input: json!({"duration_ms":60_000}),
        artifacts: None,
    };
    let mut bytes = serde_json::to_vec(&request).unwrap();
    bytes.push(b'\n');
    stdin.write_all(&bytes).await.unwrap();
    let pid = marker(directory.path(), "started").await;
    stdin.shutdown().await.unwrap();
    drop(stdin);
    let output = tokio::time::timeout(Duration::from_secs(2), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(output.status.success());
    let reply: CooperativeResponse = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply.cleanup, CleanupOutcome::Complete);
    assert!(reply.response.result.is_none());
    assert!(reply.response.outputs.is_empty());
    assert!(reply.response.error.unwrap().contains("取消"));
    marker(directory.path(), "cancel_received").await;
    marker(directory.path(), "cleaned").await;
    assert_exited(&pid).await;
}

#[tokio::test]
async fn cancellation_preserves_response_bytes_already_read_before_control_frame() {
    let directory = tempfile::tempdir().unwrap();
    let plugin =
        Arc::new(ProcessPlugin::new(manifest(directory.path(), "partial_response")).unwrap());
    let cancel = CancellationToken::new();
    let task = {
        let plugin = plugin.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move { plugin.execute(OPERATION, json!({}), cancel).await })
    };
    marker(directory.path(), "partial_written").await;
    let pid = marker(directory.path(), "started").await;
    cancel.cancel();
    let result = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(result, Err(Error::Cancelled)));
    assert!(!plugin.has_unresolved_resources());
    marker(directory.path(), "cancel_received").await;
    marker(directory.path(), "cleaned").await;
    assert_exited(&pid).await;
}

#[tokio::test]
async fn real_transport_failures_reap_children_and_never_confirm_cleanup() {
    for mode in [
        "eof",
        "nonzero",
        "nonzero_response",
        "wrong_id",
        "wrong_version",
        "wrong_response",
        "legacy_response",
        "oversized_stdout",
        "oversized_stderr",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let plugin = ProcessPlugin::new(manifest(directory.path(), mode)).unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            plugin.execute(
                OPERATION,
                json!({"duration_ms":60_000}),
                CancellationToken::new(),
            ),
        )
        .await
        .expect("传输错误必须受限退出");
        assert!(
            matches!(result, Err(Error::CleanupFailed)),
            "故障模式 {mode} 应拒绝响应"
        );
        assert!(
            plugin.has_unresolved_resources(),
            "故障模式 {mode} 不能确认外部资源已清理"
        );
        assert_exited(&marker(directory.path(), "started").await).await;
        assert!(!directory.path().join("cleaned").exists());
    }
}

async fn lifecycle_setup(
    directory: &Path,
    mode: &str,
) -> (Arc<Application>, Arc<PluginService>, Arc<ProcessPlugin>) {
    let artifacts = Arc::new(
        FileArtifacts::open(directory.join("artifacts"))
            .await
            .unwrap(),
    );
    let deployed = directory.join("deployed");
    tokio::fs::create_dir_all(deployed.join("cooperative_demo"))
        .await
        .unwrap();
    let manifest = manifest(directory, mode);
    tokio::fs::write(
        deployed.join("cooperative_demo").join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .await
    .unwrap();
    let catalog = Arc::new(
        FilePluginCatalog::open(&deployed, artifacts.clone())
            .await
            .unwrap(),
    );
    let plugin = Arc::new(ProcessPlugin::with_artifacts(manifest, artifacts).unwrap());
    let app = Application::new(
        Arc::new(SqliteStore::open(directory.join("tasks.sqlite")).unwrap()),
        vec![],
        1,
        8,
    )
    .unwrap();
    let service = PluginService::new(app.clone(), catalog, Default::default());
    service
        .seed(PluginContribution {
            id: "cooperative_demo".into(),
            version: "0.1.0".into(),
            executor: plugin.clone(),
        })
        .await
        .unwrap();
    (app, service, plugin)
}

#[tokio::test]
async fn real_application_unload_waits_cleanup_removes_owner_and_preserves_task_history() {
    let directory = tempfile::tempdir().unwrap();
    let (app, service, plugin) = lifecycle_setup(directory.path(), "").await;
    let job = app
        .submit_async(OPERATION.into(), json!({"duration_ms":60_000}))
        .await
        .unwrap();
    let pid = marker(directory.path(), "started").await;
    assert_eq!(
        app.get_async(job.id.clone()).await.unwrap().status,
        JobStatus::Running
    );
    let info = service.unload("cooperative_demo".into()).await.unwrap();
    assert_eq!(info.state, PluginState::Unloaded);
    assert!(!info.cleanup_failed);
    assert!(!plugin.has_unresolved_resources());
    marker(directory.path(), "cancel_received").await;
    marker(directory.path(), "cleaned").await;
    assert_exited(&pid).await;
    assert!(service.list().is_empty());
    assert!(app.operations().is_empty());
    let terminal = app.get_async(job.id).await.unwrap();
    assert_eq!(terminal.status, JobStatus::Cancelled);
    assert!(terminal.result.is_none());
    assert!(matches!(
        app.submit_async(OPERATION.into(), json!({})).await,
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        service.unload("cooperative_demo".into()).await,
        Err(Error::NotFound(_))
    ));
    service.close();
    service.wait().await;
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn real_application_failed_cleanup_keeps_draining_owner_and_rejects_repeat_unload_reload_and_submit()
 {
    for mode in ["ignore", "failed"] {
        let directory = tempfile::tempdir().unwrap();
        let (app, service, plugin) = lifecycle_setup(directory.path(), mode).await;
        let generation = service.list()[0].generation.clone();
        let job = app
            .submit_async(OPERATION.into(), json!({"duration_ms":60_000}))
            .await
            .unwrap();
        let pid = marker(directory.path(), "started").await;
        assert_eq!(
            app.get_async(job.id.clone()).await.unwrap().status,
            JobStatus::Running
        );
        assert!(matches!(
            service.unload("cooperative_demo".into()).await,
            Err(Error::CleanupFailed)
        ));
        assert!(plugin.has_unresolved_resources());
        assert_exited(&pid).await;
        let owners = service.list();
        assert_eq!(owners.len(), 1);
        assert_eq!(owners[0].state, PluginState::Draining);
        assert!(owners[0].cleanup_failed);
        assert_eq!(owners[0].generation, generation);
        assert!(app.operations().is_empty());
        assert!(matches!(
            service.unload("cooperative_demo".into()).await,
            Err(Error::CleanupFailed)
        ));
        assert!(matches!(
            service.load("cooperative_demo".into()).await,
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            app.submit_async(OPERATION.into(), json!({})).await,
            Err(Error::NotFound(_))
        ));
        assert_eq!(service.list()[0].generation, generation);
        let terminal = app.get_async(job.id).await.unwrap();
        assert_eq!(terminal.status, JobStatus::Failed);
        assert_eq!(terminal.error, Some(Error::CleanupFailed.to_string()));
        assert!(terminal.result.is_none());
        assert!(!directory.path().join("cleaned").exists());
        service.close();
        service.wait().await;
        app.shutdown().await.unwrap();
    }
}
