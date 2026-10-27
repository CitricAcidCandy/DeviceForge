//! 原贡献与别名原子装卸、协作取消、失败清理以及旧代与旧历史隔离。
use super::{config::*, support::*};
use apk_domain::{Executor, JobStatus, plugins::PluginState};
use serde_json::to_value;
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};

fn names(fixture: &Fixture) -> BTreeSet<String> {
    fixture
        .app
        .operations()
        .into_iter()
        .map(|operation| operation.id)
        .collect()
}
fn expected() -> BTreeSet<String> {
    [
        WRITE,
        READ,
        GLOBAL,
        "plugin.aliasprobe.discover",
        "plugin.aliasprobe.write",
        "plugin.aliasprobe.read",
        "plugin.aliasprobe.global",
        "plugin.aliasprobe.ping",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}
async fn observe_atomic(
    fixture: &Fixture,
    task: &tokio::task::JoinHandle<apk_domain::Result<apk_domain::plugins::PluginInfo>>,
) {
    let end = Instant::now() + Duration::from_secs(12);
    while !task.is_finished() {
        let snapshot = names(fixture);
        assert!(
            snapshot.is_empty() || snapshot == expected(),
            "不得发布半份原贡献或别名"
        );
        assert!(Instant::now() < end, "装卸未收敛");
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn publish_unload_reload_are_atomic_and_keep_success_cancelled_history() {
    let fixture = Fixture::unloaded(3, config(), None, vec![]);
    let first_revision = fixture.app.operations_snapshot().0;
    assert!(names(&fixture).is_empty());
    let load = {
        let plugins = fixture.plugins.clone();
        tokio::spawn(async move { plugins.load(PROVIDER.into()).await })
    };
    observe_atomic(&fixture, &load).await;
    let first = load.await.unwrap().unwrap();
    assert_eq!(names(&fixture), expected());
    assert_eq!(
        first.operations.into_iter().collect::<BTreeSet<_>>(),
        expected()
    );
    assert_eq!(fixture.app.operations_snapshot().0, first_revision + 1);
    fixture.refresh().await;
    let reference = fixture.provider();
    let success = fixture
        .app
        .submit_async(WRITE.into(), old_input("history", Some("same"), "normal"))
        .await
        .unwrap();
    let history = settled(&fixture.app, &success.id).await;
    assert_eq!(history.status, JobStatus::Succeeded);
    let running = fixture
        .app
        .submit_async(
            WRITE.into(),
            old_input("unload-active", Some("same"), "hold"),
        )
        .await
        .unwrap();
    let ready = fixture.ready("unload-active").await;
    let queued = fixture
        .devices
        .invoke(fixture.action("write", Some("same"), "unload-queued", "hold"))
        .await
        .unwrap();
    let unload = {
        let plugins = fixture.plugins.clone();
        tokio::spawn(async move { plugins.unload(PROVIDER.into()).await })
    };
    observe_atomic(&fixture, &unload).await;
    let unloaded = unload.await.unwrap().unwrap();
    assert_eq!(unloaded.state, PluginState::Unloaded);
    assert!(!unloaded.cleanup_failed);
    assert_eq!(
        fixture.event("unload-active", "cleaned").await["pid"],
        ready["pid"]
    );
    fixture.exited("unload-active").await;
    assert!(fixture.recorded("unload-queued", "started").is_none());
    assert_eq!(
        settled(&fixture.app, &running.id).await.status,
        JobStatus::Cancelled
    );
    assert_eq!(
        settled(&fixture.app, &queued.id).await.status,
        JobStatus::Cancelled
    );
    assert!(names(&fixture).is_empty());
    assert!(fixture.devices.providers().is_empty());
    assert!(fixture.devices.directories().is_empty());
    assert_eq!(fixture.app.operations_snapshot().0, first_revision + 2);
    assert_eq!(
        code(
            fixture
                .app
                .submit_async(WRITE.into(), history.input.clone())
                .await
        ),
        "not_found"
    );
    let next = fixture.plugins.load(PROVIDER.into()).await.unwrap();
    assert_ne!(next.generation, reference.generation);
    assert_eq!(fixture.app.operations_snapshot().0, first_revision + 3);
    let mut stale = fixture.action("write", Some("same"), "stale", "normal");
    stale.generation = reference.generation;
    assert_eq!(code(fixture.devices.invoke(stale).await), "conflict");
    assert_eq!(
        code(
            fixture
                .app
                .submit_async(
                    WRITE.into(),
                    old_input("unobserved", Some("same"), "normal")
                )
                .await
        ),
        "conflict"
    );
    fixture.refresh().await;
    let current = fixture
        .app
        .submit_async(
            WRITE.into(),
            old_input("after-reload", Some("same"), "normal"),
        )
        .await
        .unwrap();
    assert_eq!(
        settled(&fixture.app, &current.id).await.status,
        JobStatus::Succeeded
    );
    assert_eq!(
        to_value(fixture.app.get(&history.id).unwrap()).unwrap(),
        to_value(history).unwrap()
    );
    assert_eq!(
        fixture.app.get(&running.id).unwrap().status,
        JobStatus::Cancelled
    );
    fixture.exited("history").await;
    fixture.exited("after-reload").await;
    fixture.shutdown().await;
}

#[tokio::test]
async fn failed_cleanup_keeps_history_but_alias_and_native_queued_and_new_tasks_execute() {
    let fixture = Fixture::new(3, config()).await;
    let running = fixture
        .app
        .submit_async(
            WRITE.into(),
            old_input("failed-cleanup", Some("same"), "failed"),
        )
        .await
        .unwrap();
    let ready = fixture.ready("failed-cleanup").await;
    let old = fixture
        .app
        .submit_async(WRITE.into(), old_input("blocked-old", Some("same"), "hold"))
        .await
        .unwrap();
    let new = fixture
        .devices
        .invoke(fixture.action("write", Some("same"), "blocked-new", "hold"))
        .await
        .unwrap();
    fixture.app.cancel_async(running.id.clone()).await.unwrap();
    fixture.event("failed-cleanup", "cleanup_failed").await;
    wait_gone(pid(&ready)).await;
    // 进程退出早于宿主写入清理诊断，必须等待可观察状态，而非依赖调度先后。
    let diagnostic_deadline = Instant::now() + Duration::from_secs(5);
    while !fixture.plugin().has_unresolved_resources() || !fixture.plugins.list()[0].cleanup_failed
    {
        assert!(Instant::now() < diagnostic_deadline, "清理失败诊断未就绪");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let failed_history = to_value(fixture.app.get(&running.id).unwrap()).unwrap();
    assert!(fixture.plugin().has_unresolved_resources());
    assert!(fixture.plugins.list()[0].cleanup_failed);
    // 两个入口均可继续；不假定异步锁等待者的先后调度顺序。
    fixture.release("blocked-old");
    fixture.release("blocked-new");
    for (job, label) in [(old, "blocked-old"), (new, "blocked-new")] {
        fixture.ready(label).await;
        assert_eq!(
            settled(&fixture.app, &job.id).await.status,
            JobStatus::Succeeded
        );
        fixture.exited(label).await;
        assert!(fixture.plugin().has_unresolved_resources());
        assert!(fixture.plugins.list()[0].cleanup_failed);
    }
    let alias = fixture
        .app
        .submit_async(WRITE.into(), old_input("new-old", Some("same"), "normal"))
        .await
        .unwrap();
    let native = fixture
        .devices
        .invoke(fixture.action("write", Some("same"), "new-native", "normal"))
        .await
        .unwrap();
    for (job, label) in [(alias, "new-old"), (native, "new-native")] {
        assert_eq!(
            settled(&fixture.app, &job.id).await.status,
            JobStatus::Succeeded
        );
        fixture.exited(label).await;
    }
    let previous = fixture.provider();
    let unloaded = fixture.plugins.unload(PROVIDER.into()).await.unwrap();
    assert_eq!(unloaded.state, PluginState::Unloaded);
    assert!(unloaded.cleanup_failed);
    assert!(fixture.plugins.list().is_empty());
    assert!(names(&fixture).is_empty());
    assert!(fixture.devices.directories().is_empty());
    let loaded = fixture.plugins.load(PROVIDER.into()).await.unwrap();
    assert_ne!(loaded.generation, previous.generation);
    // 新代不继承旧代告警；旧卸载诊断与任务历史仍然完整保留。
    assert!(!loaded.cleanup_failed);
    assert!(unloaded.cleanup_failed);
    assert_eq!(
        to_value(fixture.app.get(&running.id).unwrap()).unwrap(),
        failed_history
    );
    assert_eq!(names(&fixture), expected());
    let mut stale = fixture.action("write", Some("same"), "stale-after-cleanup", "normal");
    stale.generation = previous.generation;
    assert_eq!(code(fixture.devices.invoke(stale).await), "conflict");
    assert_eq!(
        fixture.app.get(&running.id).unwrap().status,
        JobStatus::Cancelled
    );
    fixture.shutdown().await;
}
