//! 注册旧快照与执行器同轮询取消的回归，不依赖真实进程的测试时钟。
use crate::{
    Application,
    operation_aliases::Config,
    registry::{Prepared, Registry},
};
use apk_domain::{Executor, JobStatus, Operation, Result, plugins::PluginContribution};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;

struct CancelsBeforeReturning(AtomicUsize);
#[async_trait]
impl Executor for CancelsBeforeReturning {
    fn operations(&self) -> Vec<Operation> {
        vec![Operation {
            execution: None,
            id: "plugin.alias_race.work".into(),
            title: "同轮询取消测试".into(),
            input_schema: json!({"type":"object"}),
        }]
    }
    async fn execute(
        &self,
        operation: &str,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        assert_eq!(operation, "plugin.alias_race.work");
        self.0.fetch_add(1, Ordering::SeqCst);
        // 模拟其他线程的取消已到达，但执行器仍在这次轮询里返回成功。
        cancel.cancel();
        Ok(input)
    }
}

fn config() -> Config {
    serde_json::from_value(json!({"format_version":1,"bindings":[{
        "operation":{"id":"legacy.race","title":"旧入口","input_schema":{"type":"object"}},
        "target":{"kind":"operation","plugin_id":"alias_race","operation":"plugin.alias_race.work"},
        "input":"identity","result":{"kind":"identity"}
    }]}))
    .unwrap()
}

fn contribution(executor: Arc<CancelsBeforeReturning>) -> PluginContribution {
    PluginContribution {
        id: "alias_race".into(),
        version: "1".into(),
        executor,
    }
}

#[tokio::test]
async fn alias_never_accepts_success_returned_in_the_same_poll_as_cancellation() {
    let app = Application::new_with_bindings(
        Arc::new(apk_infrastructure::store::SqliteStore::open(":memory:").unwrap()),
        vec![],
        1,
        8,
        config(),
    )
    .unwrap();
    let executor = Arc::new(CancelsBeforeReturning(AtomicUsize::new(0)));
    app.registry
        .publish(
            Prepared::new_with_bindings(contribution(executor.clone()), &app.registry.1).unwrap(),
        )
        .unwrap();
    let input = json!({"preserved":"旧输入"});
    let job = app.submit("legacy.race", input.clone()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let current = app.get(&job.id).unwrap();
            if current.status.is_terminal() {
                assert_eq!(current.status, JobStatus::Cancelled);
                assert_eq!(current.operation, "legacy.race");
                assert_eq!(current.input, input);
                assert!(current.result.is_none());
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(executor.0.load(Ordering::SeqCst), 1);
    assert_eq!(app.list(8).unwrap().len(), 1);
    app.shutdown().await.unwrap();
}

#[test]
fn alias_snapshot_is_revoked_with_target_and_never_reused_after_reload() {
    let registry = Registry::new_with_bindings(vec![], config()).unwrap();
    let executor = Arc::new(CancelsBeforeReturning(AtomicUsize::new(0)));
    let prepare =
        || Prepared::new_with_bindings(contribution(executor.clone()), &registry.1).unwrap();
    let first = registry.publish(prepare()).unwrap();
    let old_alias = registry.find("legacy.race").unwrap();
    let old_target = registry.find("plugin.alias_race.work").unwrap();
    assert!(Arc::ptr_eq(old_alias.target.as_ref().unwrap(), &old_target));
    assert!(Arc::ptr_eq(
        old_alias.owner.as_ref().unwrap(),
        old_target.owner.as_ref().unwrap()
    ));
    let owner = registry.detach("alias_race").unwrap();
    assert!(registry.find("legacy.race").is_err());
    assert!(registry.find("plugin.alias_race.work").is_err());
    assert!(!registry.current("legacy.race", &old_alias).unwrap());
    assert!(old_alias.owner.as_ref().unwrap().cancel.is_cancelled());
    registry.finish(&owner).unwrap();
    let second = registry.publish(prepare()).unwrap();
    assert_ne!(first.generation, second.generation);
    assert!(!registry.current("legacy.race", &old_alias).unwrap());
    assert!(!Arc::ptr_eq(
        &registry.find("legacy.race").unwrap(),
        &old_alias
    ));
    assert_eq!(registry.operations().0, 3);
}
