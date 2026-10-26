//! 历史清理告警与独立进程本次结果隔离；不代表外部资源或宿主准入验收。
#[path = "device_deadline_fixtures/liveness.rs"]
mod liveness;

use apk_domain::{Error, ExecutionContext, Executor};
use apk_infrastructure::plugins::ProcessPlugin;
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

fn node() -> std::path::PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::split_paths(&std::env::var_os("PATH").expect("Node PATH"))
        .map(|root| root.join(name))
        .find(|path| path.is_file())
        .expect("真实进程回归需要 Node")
}

async fn invoke(plugin: &ProcessPlugin, input: Value) -> apk_domain::Result<Value> {
    plugin
        .execute_with_context(
            "plugin.cleanup-isolation.run",
            input,
            CancellationToken::new(),
            ExecutionContext {
                deadline: Some(std::time::Instant::now() + Duration::from_secs(20)),
            },
        )
        .await
}

async fn exited(root: &Path, name: &str) -> Value {
    let marker: Value = serde_json::from_slice(
        &tokio::fs::read(root.join(format!("{name}.json")))
            .await
            .expect("本次业务实际执行标记"),
    )
    .expect("真实进程标记合法");
    let pid = u32::try_from(marker["pid"].as_u64().expect("真实 PID")).unwrap();
    assert!(!liveness::alive(pid), "本次返回前必须确认直接进程退出");
    marker
}

#[tokio::test]
async fn failed_cleanup_then_independent_success_keeps_historical_warning_and_real_errors() {
    for protocol in [3, 4] {
        let directory = tempfile::tempdir().unwrap();
        let manifest = serde_json::from_value(json!({
            "id":"cleanup-isolation","version":"1","protocol_version":protocol,
            "executable":node(),
            "args":[Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cleanup_isolation.mjs"),directory.path()],
            "operations":[{"name":"run","title":"清理隔离","input_schema":{"type":"object"}}]
        }))
        .unwrap();
        let plugin = ProcessPlugin::new(manifest).unwrap();
        let failed = invoke(&plugin, json!({"name":"first","cleanup":"failed"})).await;
        assert!(matches!(failed, Err(Error::CleanupFailed)));
        let first = exited(directory.path(), "first").await;
        assert!(plugin.has_unresolved_resources());

        // 串行发起第二笔，确保失败标记在新准入和后置判断之前就已存在。
        let input = json!({"name":"second","cleanup":"complete","payload":[0,255,13,10]});
        let succeeded = invoke(&plugin, input.clone())
            .await
            .expect("历史清理失败不能污染独立进程的真实成功");
        let second = exited(directory.path(), "second").await;
        assert_ne!(first["request_id"], second["request_id"]);
        assert_ne!(first["directory"], second["directory"]);
        assert_eq!(second["protocol_version"], protocol);
        assert_eq!(succeeded["result"]["pid"], second["pid"]);
        assert_eq!(succeeded["result"]["input"], input);
        assert_eq!(succeeded["artifacts"], json!([]));
        assert!(plugin.has_unresolved_resources(), "新成功不能抹掉旧告警");

        let failed_again = invoke(&plugin, json!({"name":"third","cleanup":"failed"})).await;
        assert!(
            matches!(failed_again, Err(Error::CleanupFailed)),
            "放行独立调用不能把本次真实清理失败伪装成成功"
        );
        exited(directory.path(), "third").await;
        assert!(plugin.has_unresolved_resources());
    }
}
