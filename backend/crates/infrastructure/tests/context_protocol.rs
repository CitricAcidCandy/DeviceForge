//! 公开ProcessPlugin与独立Node原帧的协议4真实进程验收。
use apk_domain::{Error, ExecutionContext, Executor};
use apk_infrastructure::plugins::ProcessPlugin;
use apk_plugin_sdk::Manifest;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    process::Command,
    time::{sleep, timeout},
};
use tokio_util::sync::CancellationToken;

struct Fixture {
    directory: TempDir,
    node: String,
    plugin: ProcessPlugin,
}
impl Fixture {
    async fn new(mode: &str) -> Self {
        let node = Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .await
            .expect("定位测试Node");
        assert!(node.status.success());
        let node = String::from_utf8(node.stdout)
            .expect("Node路径UTF-8")
            .trim()
            .to_owned();
        let directory = tempfile::tempdir().expect("本次协议夹具目录");
        let marker = directory.path().join("ready.json");
        let script =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/context_protocol.mjs");
        let manifest: Manifest = serde_json::from_value(json!({
            "id":"context-real","version":"1","protocol_version":4,"executable":node,
            "args":[script,marker,mode],"operations":[{"name":"run","title":"上下文","input_schema":{}}]
        })).expect("公开清单4");
        let plugin = ProcessPlugin::new(manifest).expect("接纳显式协议4");
        Self {
            directory,
            node,
            plugin,
        }
    }
    fn ready(&self) -> PathBuf {
        self.directory.path().join("ready.json")
    }
    async fn marker(&self) -> Value {
        timeout(Duration::from_secs(10), async {
            loop {
                if let Ok(bytes) = tokio::fs::read(self.ready()).await
                    && let Ok(value) = serde_json::from_slice(&bytes)
                {
                    break value;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("真实Start握手标记")
    }
    async fn assert_exited(&self, marker: &Value) {
        let pid = marker["pid"].as_u64().expect("真实PID");
        let check = format!(
            "try {{ process.kill({pid}, 0); process.exit(1); }} catch {{ process.exit(0); }}"
        );
        let status = Command::new(&self.node)
            .args(["-e", &check])
            .status()
            .await
            .expect("核对直接PID");
        assert!(status.success(), "返回时直接进程必须已退出");
    }
}
fn context(duration: Duration) -> ExecutionContext {
    ExecutionContext {
        deadline: Some(std::time::Instant::now() + duration),
    }
}

#[tokio::test]
async fn handshake_real_process_preserves_budget_and_old_request_fields() {
    for mode in ["normal", "stderr-ready", "stderr-first"] {
        let fixture = Fixture::new(mode).await;
        let budget = Duration::from_secs(20);
        let input = if mode == "stderr-first" {
            json!({"中文":"输入","large":"x".repeat(400_000)})
        } else {
            json!({"中文":"输入"})
        };
        let result = fixture
            .plugin
            .execute_with_context(
                "plugin.context-real.run",
                input.clone(),
                CancellationToken::new(),
                context(budget),
            )
            .await
            .expect("协议4成功");
        let remaining = result["result"]["remaining_timeout_ns"]
            .as_u64()
            .expect("严格整数剩余预算");
        assert!(remaining > 0 && u128::from(remaining) <= budget.as_nanos());
        assert_eq!(result["result"]["input"], input);
        assert_eq!(result["artifacts"], json!([]));
        let marker = fixture.marker().await;
        assert!(marker["request"].get("deadline").is_none());
        assert!(marker["request"].get("execution_context").is_none());
        fixture.assert_exited(&marker).await;
        assert!(!fixture.plugin.has_unresolved_resources());
    }
}

#[tokio::test]
async fn running_cancel_uses_version_four_control_and_confirms_exit() {
    let fixture = Fixture::new("hold").await;
    let cancel = CancellationToken::new();
    let execution = fixture.plugin.execute_with_context(
        "plugin.context-real.run",
        json!({}),
        cancel.clone(),
        context(Duration::from_secs(20)),
    );
    tokio::pin!(execution);
    let marker = tokio::select! {
        marker = fixture.marker() => marker,
        result = &mut execution => panic!("就绪前提前结束：{result:?}"),
    };
    cancel.cancel();
    assert!(matches!(execution.await, Err(Error::Cancelled)));
    let control: Value = serde_json::from_slice(
        &tokio::fs::read(fixture.ready().with_extension("json.control"))
            .await
            .expect("真实控制标记"),
    )
    .unwrap();
    assert_eq!(control["protocol_version"], 4);
    assert_eq!(control["reason"], "cancelled");
    fixture.assert_exited(&marker).await;
    assert!(!fixture.plugin.has_unresolved_resources());
}

#[tokio::test]
async fn malformed_ready_preserves_unconfirmed_risk_and_never_starts() {
    let fixture = Fixture::new("bad-ready").await;
    let result = fixture
        .plugin
        .execute_with_context(
            "plugin.context-real.run",
            json!({}),
            CancellationToken::new(),
            context(Duration::from_secs(20)),
        )
        .await;
    assert!(matches!(result, Err(Error::CleanupFailed)));
    assert!(fixture.plugin.has_unresolved_resources());
    assert!(!fixture.ready().exists());
    let spawned: Value = serde_json::from_slice(
        &tokio::fs::read(fixture.ready().with_extension("json.spawn"))
            .await
            .expect("真实启动PID"),
    )
    .unwrap();
    fixture.assert_exited(&spawned).await;
}

#[tokio::test]
async fn expired_original_context_starts_no_process_or_handshake() {
    let fixture = Fixture::new("normal").await;
    let result = fixture
        .plugin
        .execute_with_context(
            "plugin.context-real.run",
            json!({}),
            CancellationToken::new(),
            ExecutionContext {
                deadline: Some(std::time::Instant::now() - Duration::from_secs(1)),
            },
        )
        .await;
    assert!(matches!(result, Err(Error::Timeout)));
    assert!(!fixture.ready().exists());
    assert!(!fixture.plugin.has_unresolved_resources());
}

#[tokio::test]
async fn original_deadline_after_handshake_sends_timeout_and_confirms_exit() {
    let fixture = Fixture::new("hold").await;
    let execution = fixture.plugin.execute_with_context(
        "plugin.context-real.run",
        json!({}),
        CancellationToken::new(),
        context(Duration::from_secs(5)),
    );
    tokio::pin!(execution);
    let marker = tokio::select! {
        marker = fixture.marker() => marker,
        result = &mut execution => panic!("真实握手前不应结束：{result:?}"),
    };
    assert!(matches!(execution.await, Err(Error::Timeout)));
    let control: Value = serde_json::from_slice(
        &tokio::fs::read(fixture.ready().with_extension("json.control"))
            .await
            .expect("期限控制原帧"),
    )
    .unwrap();
    assert_eq!(control["protocol_version"], 4);
    assert_eq!(control["reason"], "timeout");
    fixture.assert_exited(&marker).await;
    assert!(!fixture.plugin.has_unresolved_resources());
}
