//! 独立原帧进程验证同插件采样与其它贡献的产物权限，不用宿主生成期望响应。
use apk_domain::{Error, ExecutionContext, Executor, Result, artifacts::*};
use apk_infrastructure::plugins::ProcessPlugin;
use apk_plugin_sdk::Manifest;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct DeniedArtifacts(AtomicUsize);
impl DeniedArtifacts {
    fn denied<T>(&self) -> Result<T> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(Error::Dependency("本夹具不得调用产物端口".into()))
    }
}
#[async_trait]
impl ArtifactStore for DeniedArtifacts {
    async fn put(&self, _: String, _: ArtifactStream) -> Result<Artifact> {
        self.denied()
    }
    async fn get(&self, _: &str) -> Result<Artifact> {
        self.denied()
    }
    async fn delete(&self, _: &str) -> Result<Artifact> {
        self.denied()
    }
    async fn download(&self, _: &str) -> Result<(Artifact, ArtifactStream)> {
        self.denied()
    }
    async fn archive_entries(&self, _: &str, _: usize, _: usize) -> Result<ArchivePage> {
        self.denied()
    }
}

fn manifest(node: &str, marker: &Path, mode: &str) -> Manifest {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/context_protocol.mjs");
    serde_json::from_value(json!({
        "id":"performance-fixture","version":"1","protocol_version":4,"executable":node,"args":[script,marker,mode],
        "performance":{"api_version":2,"sample_operation":"sample","device_capability":{"id":"sample","version":1}},
        "artifacts":{"input_pointers":["/input/artifact_id"],"outputs":true},
        "devices":{"api_version":3,"platform":"fixture","discover_operation":"discover","capabilities":[
            {"id":"sample","version":1,"operation":"sample","scope":"device","access":"read","execution_timeout_ms":10000}]},
        "operations":[{"name":"discover","title":"发现","input_schema":{"type":"object"}},
            {"name":"capture","title":"其它产物贡献","input_schema":{"type":"object"}},
            {"name":"sample","title":"采样","input_schema":{"type":"object","additionalProperties":false,
                "properties":{"device_id":{"type":"string"},"input":{"type":"object","additionalProperties":false,
                    "properties":{"package":{"type":"string"}},"required":["package"]}},"required":["device_id","input"]}}]
    })).unwrap()
}

async fn node_path() -> String {
    let output = tokio::process::Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

async fn invoke(plugin: &ProcessPlugin, name: &str) -> Result<Value> {
    plugin
        .execute_with_context(
            &format!("plugin.performance-fixture.{name}"),
            json!({"device_id":"fixture-1","input":{"package":"com.example.app"}}),
            CancellationToken::new(),
            ExecutionContext {
                deadline: Some(std::time::Instant::now() + Duration::from_secs(10)),
            },
        )
        .await
}

async fn marker(path: &Path) -> Value {
    serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap()
}

async fn assert_exited(node: &str, observation: &Value) {
    let pid = observation["pid"].as_u64().unwrap();
    let check =
        format!("try {{ process.kill({pid}, 0); process.exit(1); }} catch {{ process.exit(0); }}");
    let result = tokio::process::Command::new(node)
        .args(["-e", &check])
        .status()
        .await
        .unwrap();
    assert!(result.success(), "返回前真实直接进程必须退出");
}

#[tokio::test]
async fn sampling_gets_empty_authorization_without_storage_and_preserves_other_contribution_permission()
 {
    let directory = tempfile::tempdir().unwrap();
    let node = node_path().await;
    let sample_marker = directory.path().join("sample.json");
    let plugin = ProcessPlugin::new(manifest(&node, &sample_marker, "normal")).unwrap();
    let result = invoke(&plugin, "sample").await.unwrap();
    assert_eq!(result["artifacts"], json!([]));
    let observation = marker(&sample_marker).await;
    assert_eq!(
        observation["request"]["artifacts"],
        json!({"inputs":[],"output_directory":null})
    );
    assert_exited(&node, &observation).await;
    assert!(!plugin.has_unresolved_resources());
    assert!(
        matches!(invoke(&plugin, "capture").await, Err(Error::Dependency(_))),
        "其它贡献仍要求其声明的产物存储"
    );

    let capture_marker = directory.path().join("capture.json");
    let store = Arc::new(DeniedArtifacts::default());
    let plugin =
        ProcessPlugin::with_artifacts(manifest(&node, &capture_marker, "normal"), store.clone())
            .unwrap();
    invoke(&plugin, "capture").await.unwrap();
    let observation = marker(&capture_marker).await;
    let output = observation["request"]["artifacts"]["output_directory"]
        .as_str()
        .unwrap();
    assert!(!Path::new(output).exists(), "调用返回后私有输出目录已收口");
    assert_exited(&node, &observation).await;
    assert_eq!(store.0.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn successful_sample_outputs_are_rejected_before_any_artifact_store_call() {
    let directory = tempfile::tempdir().unwrap();
    let node = node_path().await;
    let path = directory.path().join("outputs.json");
    let store = Arc::new(DeniedArtifacts::default());
    let plugin =
        ProcessPlugin::with_artifacts(manifest(&node, &path, "outputs"), store.clone()).unwrap();
    assert!(
        matches!(invoke(&plugin, "sample").await, Err(Error::Invalid(message)) if message == "性能采样响应不得包含产物输出")
    );
    let observation = marker(&path).await;
    assert_eq!(
        observation["request"]["artifacts"],
        json!({"inputs":[],"output_directory":null})
    );
    assert_exited(&node, &observation).await;
    assert_eq!(store.0.load(Ordering::SeqCst), 0);
    assert!(!plugin.has_unresolved_resources());
}

#[tokio::test]
async fn failed_sample_outputs_cannot_publish_and_keep_transport_cleanup_risk() {
    let directory = tempfile::tempdir().unwrap();
    let node = node_path().await;
    let path = directory.path().join("error-outputs.json");
    let store = Arc::new(DeniedArtifacts::default());
    let plugin =
        ProcessPlugin::with_artifacts(manifest(&node, &path, "error-outputs"), store.clone())
            .unwrap();
    // 原协议先拒绝 error 与 outputs 的无效组合，采样不能弱化传输清理门禁。
    assert!(matches!(
        invoke(&plugin, "sample").await,
        Err(Error::CleanupFailed)
    ));
    let observation = marker(&path).await;
    assert_eq!(
        observation["request"]["artifacts"],
        json!({"inputs":[],"output_directory":null})
    );
    assert_exited(&node, &observation).await;
    assert_eq!(store.0.load(Ordering::SeqCst), 0);
    assert!(plugin.has_unresolved_resources());
}
