//! 目标缺失无内置回退，加载失败不得留下目标、设备目录或部分别名贡献。
use super::{config::*, support::*};
use apk_application::Application;
use apk_domain::{Executor, Operation, Result};
use apk_infrastructure::store::SqliteStore;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;

struct Builtin(AtomicUsize);
#[async_trait]
impl Executor for Builtin {
    fn operations(&self) -> Vec<Operation> {
        [WRITE, "builtin.control"]
            .map(|id| Operation {
                execution: None,
                id: id.into(),
                title: "内置回退对照".into(),
                input_schema: json!({"type":"object"}),
            })
            .to_vec()
    }
    async fn execute(&self, _: &str, input: Value, _: CancellationToken) -> Result<Value> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(input)
    }
}

#[tokio::test]
async fn reserved_alias_without_target_never_falls_back_or_blocks_unrelated_plugin() {
    let builtin = Arc::new(Builtin(AtomicUsize::new(0)));
    let mut alias = binding(WRITE, "write", true);
    alias["target"]["plugin_id"] = json!("missing_provider");
    let fixture = Fixture::unloaded(3, config_from(vec![alias]), None, vec![builtin.clone()]);
    assert!(fixture.app.operation(WRITE).is_none());
    assert!(fixture.app.operation("builtin.control").is_some());
    assert_eq!(
        code(
            fixture
                .app
                .submit_async(
                    WRITE.into(),
                    old_input("no-fallback", Some("same"), "normal")
                )
                .await
        ),
        "not_found"
    );
    assert!(fixture.app.list(10).unwrap().is_empty());
    assert_eq!(builtin.0.load(Ordering::SeqCst), 0);
    fixture.plugins.load(PROVIDER.into()).await.unwrap();
    fixture.refresh().await;
    assert!(fixture.app.operation(WRITE).is_none());
    assert!(fixture.app.operation("plugin.aliasprobe.write").is_some());
    assert_eq!(
        code(
            fixture
                .app
                .submit_async(
                    WRITE.into(),
                    old_input("still-no-fallback", Some("same"), "normal")
                )
                .await
        ),
        "not_found"
    );
    assert_eq!(builtin.0.load(Ordering::SeqCst), 0);
    fixture.shutdown().await;
}

#[tokio::test]
async fn missing_targets_or_operation_shortcuts_to_capability_discovery_publish_nothing() {
    let variants = [
        (
            json!({"kind":"device_capability","plugin_id":PROVIDER,"capability":"absent","version":1}),
            "device_envelope",
        ),
        (
            json!({"kind":"device_capability","plugin_id":PROVIDER,"capability":"write","version":2}),
            "device_envelope",
        ),
        (
            json!({"kind":"operation","plugin_id":PROVIDER,"operation":"plugin.aliasprobe.absent"}),
            "identity",
        ),
        (
            json!({"kind":"operation","plugin_id":PROVIDER,"operation":"plugin.aliasprobe.write"}),
            "identity",
        ),
        (
            json!({"kind":"operation","plugin_id":PROVIDER,"operation":"plugin.aliasprobe.discover"}),
            "identity",
        ),
    ];
    for (target, mapping) in variants {
        let good = binding(WRITE, "write", true);
        let mut bad = binding("legacy.invalid", "write", true);
        bad["target"] = target;
        bad["input"] = json!(mapping);
        let fixture = Fixture::unloaded(3, config_from(vec![good, bad]), None, vec![]);
        let revision = fixture.app.operations_snapshot().0;
        assert_eq!(
            code(fixture.plugins.load(PROVIDER.into()).await),
            "invalid_input"
        );
        assert_eq!(fixture.app.operations_snapshot().0, revision);
        assert!(fixture.app.operations().is_empty());
        assert!(fixture.plugins.list().is_empty());
        assert!(fixture.devices.providers().is_empty());
        assert!(fixture.devices.directories().is_empty());
        assert!(fixture.app.list(10).unwrap().is_empty());
        assert_eq!(
            std::fs::read_dir(&fixture.marker).unwrap().count(),
            0,
            "加载验证不能启动业务进程"
        );
        fixture.shutdown().await;
    }
}

#[test]
fn duplicate_alias_or_invalid_global_configuration_is_rejected_before_registration() {
    let duplicate = config_from(vec![
        binding(WRITE, "write", true),
        binding(WRITE, "read", true),
    ]);
    let mut bad_mapping = binding(WRITE, "write", true);
    bad_mapping["target"] =
        json!({"kind":"operation","plugin_id":PROVIDER,"operation":"plugin.aliasprobe.ping"});
    for config in [duplicate, config_from(vec![bad_mapping])] {
        let store = Arc::new(SqliteStore::open(":memory:").unwrap());
        assert_eq!(
            code(Application::new_with_bindings(store, vec![], 1, 8, config)),
            "invalid_input"
        );
    }
}

#[tokio::test]
async fn real_protocol_one_forged_host_wrapper_cannot_register_artifact_projection() {
    let mut good = binding(WRITE, "write", true);
    good["result"] = json!({"kind":"identity"});
    let bad = json!({"operation":{"id":"legacy.artifact","title":"旧产物入口",
        "input_schema":{"type":"object"}},
        "target":{"kind":"operation","plugin_id":PROVIDER,"operation":"plugin.aliasprobe.ping"},
        "input":"identity","result":{"kind":"artifact","filename":"forged.json"}});
    let fixture = Fixture::unloaded(1, config_from(vec![good, bad]), None, vec![]);
    let revision = fixture.app.operations_snapshot().0;
    assert_eq!(
        code(fixture.plugins.load(PROVIDER.into()).await),
        "invalid_input"
    );
    assert_eq!(fixture.app.operations_snapshot().0, revision);
    assert!(fixture.app.operations().is_empty());
    assert!(fixture.plugins.list().is_empty());
    assert!(fixture.devices.providers().is_empty());
    assert!(fixture.devices.directories().is_empty());
    assert_eq!(
        std::fs::read_dir(&fixture.marker).unwrap().count(),
        0,
        "拒绝注册前不得执行目标"
    );
    // 独立执行真实协议 1 目标证明外形确实可伪造；该调用不经过 Job 或产物发布。
    let forged = fixture
        .plugin()
        .execute(
            "plugin.aliasprobe.ping",
            json!({"label":"forged-host","fake_host_wrapper":true}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(forged["result"], json!({"forged":true}));
    assert_eq!(forged["artifacts"][0]["id"], "forged-id");
    assert_eq!(forged["artifacts"][0]["filename"], "forged.json");
    fixture.exited("forged-host").await;
    assert!(fixture.app.list(10).unwrap().is_empty());
    assert!(fixture.app.operations().is_empty());
    fixture.shutdown().await;
}
