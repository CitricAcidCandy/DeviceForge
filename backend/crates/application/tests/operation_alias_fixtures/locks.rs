//! 别名和公开能力共享设备写锁与提供者屏障，以真实进程门闩作为执行证据。
use super::{config::*, support::*};
use apk_domain::JobStatus;
use serde_json::json;

#[tokio::test]
async fn old_and_new_device_writes_serialize_while_other_device_runs() {
    let fixture = Fixture::new(3, config()).await;
    let old = fixture
        .app
        .submit_async(WRITE.into(), old_input("old-write", Some("same"), "hold"))
        .await
        .unwrap();
    fixture.ready("old-write").await;
    let queued = fixture
        .devices
        .invoke(fixture.action("write", Some("same"), "new-write", "hold"))
        .await
        .unwrap();
    let other = fixture
        .devices
        .invoke(fixture.action("write", Some("other"), "other-write", "hold"))
        .await
        .unwrap();
    fixture.ready("other-write").await;
    fixture.blocked(&["new-write"]).await;
    assert_eq!(
        fixture.app.get(&queued.id).unwrap().status,
        JobStatus::Queued
    );
    fixture.release("old-write");
    assert_eq!(
        settled(&fixture.app, &old.id).await.status,
        JobStatus::Succeeded
    );
    fixture.ready("new-write").await;
    for label in ["new-write", "other-write"] {
        fixture.release(label);
    }
    for job in [queued, other] {
        assert_eq!(
            settled(&fixture.app, &job.id).await.status,
            JobStatus::Succeeded
        );
    }
    for label in ["old-write", "new-write", "other-write"] {
        fixture.exited(label).await;
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn old_and_new_reads_of_same_device_really_run_together() {
    let fixture = Fixture::new(3, config()).await;
    let old = fixture
        .app
        .submit_async(READ.into(), old_input("old-read", Some("same"), "hold"))
        .await
        .unwrap();
    fixture.ready("old-read").await;
    let new = fixture
        .devices
        .invoke(fixture.action("read", Some("same"), "new-read", "hold"))
        .await
        .unwrap();
    fixture.ready("new-read").await;
    assert!(alive(pid(&fixture.recorded("old-read", "ready").unwrap())));
    assert_eq!(fixture.app.get(&old.id).unwrap().status, JobStatus::Running);
    assert_eq!(fixture.app.get(&new.id).unwrap().status, JobStatus::Running);
    for label in ["old-read", "new-read"] {
        fixture.release(label);
    }
    for job in [old, new] {
        assert_eq!(
            settled(&fixture.app, &job.id).await.status,
            JobStatus::Succeeded
        );
    }
    for label in ["old-read", "new-read"] {
        fixture.exited(label).await;
    }
    fixture.shutdown().await;
}

#[tokio::test]
async fn alias_provider_write_blocks_old_device_read_and_new_write_with_unlocked_control() {
    let fixture = Fixture::new(3, config()).await;
    let global = fixture
        .app
        .submit_async(GLOBAL.into(), old_input("provider-barrier", None, "hold"))
        .await
        .unwrap();
    fixture.ready("provider-barrier").await;
    let read = fixture
        .app
        .submit_async(READ.into(), old_input("blocked-read", Some("same"), "hold"))
        .await
        .unwrap();
    let write = fixture
        .devices
        .invoke(fixture.action("write", Some("same"), "blocked-write", "hold"))
        .await
        .unwrap();
    let control = fixture
        .app
        .submit_async(
            "plugin.aliasprobe.ping".into(),
            json!({"label":"unlocked-control"}),
        )
        .await
        .unwrap();
    assert_eq!(
        settled(&fixture.app, &control.id).await.status,
        JobStatus::Succeeded
    );
    fixture.exited("unlocked-control").await;
    fixture.blocked(&["blocked-read", "blocked-write"]).await;
    assert_eq!(fixture.app.get(&read.id).unwrap().status, JobStatus::Queued);
    assert_eq!(
        fixture.app.get(&write.id).unwrap().status,
        JobStatus::Queued
    );
    fixture.release("provider-barrier");
    assert_eq!(
        settled(&fixture.app, &global.id).await.status,
        JobStatus::Succeeded
    );
    fixture.ready("blocked-read").await;
    fixture.ready("blocked-write").await;
    for label in ["blocked-read", "blocked-write"] {
        fixture.release(label);
    }
    for job in [read, write] {
        assert_eq!(
            settled(&fixture.app, &job.id).await.status,
            JobStatus::Succeeded
        );
    }
    for label in ["provider-barrier", "blocked-read", "blocked-write"] {
        fixture.exited(label).await;
    }
    fixture.shutdown().await;
}
