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
async fn failed_cleanup_rejects_both_alias_and_native_new_and_queued_tasks() {
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
    for job in [old, new] {
        let failed = settled(&fixture.app, &job.id).await;
        assert_eq!(failed.status, JobStatus::Failed);
        assert!(failed.error.unwrap().contains("清理未确认"));
    }
    fixture.event("failed-cleanup", "cleanup_failed").await;
    wait_gone(pid(&ready)).await;
    assert!(fixture.plugin().has_unresolved_resources());
    assert!(fixture.plugins.list()[0].cleanup_failed);
    for label in ["blocked-old", "blocked-new"] {
        assert!(fixture.recorded(label, "started").is_none());
    }
    assert_eq!(
        code(
            fixture
                .app
                .submit_async(
                    WRITE.into(),
                    old_input("rejected-old", Some("same"), "normal")
                )
                .await
        ),
        "conflict"
    );
    assert_eq!(
        code(
            fixture
                .devices
                .invoke(fixture.action("write", Some("same"), "rejected-new", "normal"))
                .await
        ),
        "conflict"
    );
    assert_eq!(
        code(fixture.plugins.unload(PROVIDER.into()).await),
        "cleanup_failed"
    );
    let info = fixture.plugins.list().remove(0);
    assert_eq!(info.state, PluginState::Draining);
    assert!(info.cleanup_failed);
    assert!(names(&fixture).is_empty());
    assert!(fixture.devices.directories().is_empty());
    assert_eq!(
        code(fixture.plugins.unload(PROVIDER.into()).await),
        "cleanup_failed"
    );
    assert_eq!(
        code(fixture.plugins.load(PROVIDER.into()).await),
        "conflict"
    );
    assert_eq!(
        fixture.app.get(&running.id).unwrap().status,
        JobStatus::Cancelled
    );
    fixture.shutdown().await;
}
