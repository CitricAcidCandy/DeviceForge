use super::{
    provider::{OPERATION, Provider},
    support::{Harness, finished, output_ready, status},
    transport::completed,
};
use apk_domain::{
    Error, Executor,
    interactive::{SessionCleanup, SessionExit, SessionInput, SessionStatus, SessionStream},
    plugins::PluginState,
};
use serde_json::json;
use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

#[tokio::test(flavor = "current_thread")]
async fn cancel_revokes_all_input_clones_and_waits_cleanup_without_fabricating_output() {
    let provider = Provider::standard();
    provider.hold_cleanup.store(true, Ordering::SeqCst);
    let (harness, _) = Harness::loaded(provider.clone()).await;
    let opened = harness.open("取消监督");
    let control = provider.control(0);
    let input = control.input.clone();
    status(&harness.app, &opened.id, SessionStatus::Running).await;
    control
        .emit(1, SessionStream::Stdout, vec![0, 255])
        .await
        .unwrap();
    control
        .emit(2, SessionStream::Stderr, vec![128, 10])
        .await
        .unwrap();
    output_ready(&harness.app, &opened.id, 2).await;
    assert_eq!(
        harness.app.session_cancel(&opened.id).unwrap().status,
        SessionStatus::Stopping
    );
    assert!(input.cancel_calls.load(Ordering::SeqCst) > 0);
    assert!(input.send(b"revoked").await.is_err());
    assert!(input.eof().await.is_err());
    assert!(
        harness
            .app
            .session_send(&opened.id, b"revoked")
            .await
            .is_err()
    );
    control.wait_cancelled().await;
    assert_eq!(provider.exits.load(Ordering::SeqCst), 0);
    assert!(!control.supervisor_finished.load(Ordering::SeqCst));
    assert!(matches!(
        harness.app.session_remove(&opened.id),
        Err(Error::Conflict(_))
    ));
    assert_eq!(
        harness.app.session_cancel(&opened.id).unwrap().status,
        SessionStatus::Stopping
    );
    control.finish(completed(9));
    let final_info = finished(&harness.app, &opened.id).await;
    assert!(control.supervisor_finished.load(Ordering::SeqCst));
    assert_eq!(provider.exits.load(Ordering::SeqCst), 1);
    assert_eq!(final_info.output_sequence, 2);
    assert_eq!(final_info.completion.as_ref().unwrap().sequence, Some(9));
    assert_eq!(
        final_info.completion.as_ref().unwrap().cleanup,
        SessionCleanup::Complete
    );
    let page = harness.app.session_output(&opened.id, 0, 100).unwrap();
    assert_eq!(
        page.chunks
            .iter()
            .map(|chunk| chunk.sequence)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(page.next_sequence, 2);
    assert!(matches!(
        harness.app.session_output(&opened.id, 3, 1),
        Err(Error::Invalid(_))
    ));
    assert_eq!(
        serde_json::to_value(harness.app.session_cancel(&opened.id).unwrap()).unwrap(),
        serde_json::to_value(final_info).unwrap()
    );
    harness.stop().await;
}

#[tokio::test]
async fn finished_visibility_and_remove_wait_for_supervisor_tail_after_cached_result() {
    let (harness, _) = Harness::loaded(Provider::standard()).await;
    let opened = harness.open("监督尾部");
    let control = harness.provider.control(0);
    control.pause_supervisor_tail.store(true, Ordering::SeqCst);
    status(&harness.app, &opened.id, SessionStatus::Running).await;
    control.finish(completed(1));
    control.wait_published().await;
    assert!(!control.supervisor_finished.load(Ordering::SeqCst));
    assert_eq!(harness.provider.exits.load(Ordering::SeqCst), 0);
    assert_ne!(
        harness.app.session(&opened.id).unwrap().status,
        SessionStatus::Finished
    );
    assert!(matches!(
        harness.app.session_remove(&opened.id),
        Err(Error::Conflict(_))
    ));
    control.release_tail();
    let final_info = finished(&harness.app, &opened.id).await;
    assert!(control.supervisor_finished.load(Ordering::SeqCst));
    assert_eq!(harness.provider.exits.load(Ordering::SeqCst), 1);
    assert_eq!(final_info.completion.as_ref().unwrap().sequence, Some(1));
    harness.app.session_remove(&opened.id).unwrap();
    harness.stop().await;
}

#[tokio::test]
async fn cancelled_unload_waiter_keeps_cleanup_registered_and_reloads_new_generation() {
    let provider = Provider::standard();
    provider.hold_cleanup.store(true, Ordering::SeqCst);
    let (harness, loaded) = Harness::loaded(provider.clone()).await;
    let revision = harness.app.session_definitions().0;
    let opened = harness.open("卸载真实等待");
    let control = provider.control(0);
    status(&harness.app, &opened.id, SessionStatus::Running).await;
    control
        .emit(1, SessionStream::Stdout, vec![255, 0, 10])
        .await
        .unwrap();
    output_ready(&harness.app, &opened.id, 1).await;
    let historical_output = harness
        .app
        .session_output(&opened.id, 0, 100)
        .unwrap()
        .chunks;
    let unloading = {
        let service = harness.service.clone();
        tokio::spawn(async move { service.unload("test".into()).await })
    };
    control.wait_cancelled().await;
    status(&harness.app, &opened.id, SessionStatus::Stopping).await;
    assert!(control.input.cancel_calls.load(Ordering::SeqCst) > 0);
    assert!(control.input.send(b"revoked").await.is_err());
    assert!(!unloading.is_finished());
    assert!(harness.app.session_definitions().1.is_empty());
    assert!(harness.app.session_definitions().0 > revision);
    assert!(matches!(
        harness
            .app
            .open_session(OPERATION, json!({"label":"卸载后"})),
        Err(Error::NotFound(_))
    ));
    let draining = harness.service.list();
    assert_eq!(draining[0].state, PluginState::Draining);
    assert_eq!(draining[0].generation, loaded.generation);
    assert_eq!(provider.opens.load(Ordering::SeqCst), 1);
    unloading.abort();
    assert!(unloading.await.unwrap_err().is_cancelled());
    assert!(!control.supervisor_finished.load(Ordering::SeqCst));
    control.finish(completed(2));
    let historical = finished(&harness.app, &opened.id).await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while !harness.service.list().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let next = harness.service.load("test".into()).await.unwrap();
    assert_ne!(next.generation, loaded.generation);
    let reloaded = harness.open("新代");
    assert_eq!(reloaded.generation, next.generation);
    assert_eq!(
        harness.app.session(&opened.id).unwrap().generation,
        loaded.generation
    );
    assert_eq!(
        serde_json::to_value(harness.app.session(&opened.id).unwrap()).unwrap(),
        serde_json::to_value(historical).unwrap()
    );
    assert_eq!(
        harness
            .app
            .session_output(&opened.id, 0, 100)
            .unwrap()
            .chunks,
        historical_output
    );
    provider.control(1).finish(completed(1));
    finished(&harness.app, &reloaded.id).await;
    assert_eq!(
        harness.service.unload("test".into()).await.unwrap().state,
        PluginState::Unloaded
    );
    harness.stop().await;
}

#[tokio::test]
async fn unconfirmed_cleanup_stays_sticky_after_another_session_succeeds() {
    let provider = Provider::standard();
    let (harness, _) = Harness::loaded(provider.clone()).await;
    let first = harness.open("未确认清理");
    let second = harness.open("另一成功会话");
    status(&harness.app, &first.id, SessionStatus::Running).await;
    status(&harness.app, &second.id, SessionStatus::Running).await;
    provider.control(0).finish(SessionExit {
        outcome: None,
        cleanup: SessionCleanup::Unconfirmed,
        process_exited: false,
        sequence: None,
        failure: Some(Arc::new(Error::Dependency("测试监督首次失败".into()))),
    });
    let failed = finished(&harness.app, &first.id).await;
    assert_eq!(
        failed.completion.as_ref().unwrap().cleanup,
        SessionCleanup::Unconfirmed
    );
    assert!(!failed.completion.as_ref().unwrap().process_exited);
    assert_eq!(
        failed
            .completion
            .as_ref()
            .unwrap()
            .failure
            .as_ref()
            .unwrap()
            .code,
        "dependency_failed"
    );
    provider.control(1).finish(completed(1));
    finished(&harness.app, &second.id).await;
    assert!(provider.unresolved.load(Ordering::SeqCst));
    assert!(!harness.executor.has_unresolved_resources());
    let independent = harness.open("历史告警后独立新会话");
    status(&harness.app, &independent.id, SessionStatus::Running).await;
    assert_eq!(provider.opens.load(Ordering::SeqCst), 3);
    provider.control(2).finish(completed(1));
    let successful = finished(&harness.app, &independent.id).await;
    assert_eq!(
        successful.completion.unwrap().cleanup,
        SessionCleanup::Complete
    );
    assert!(harness.service.list()[0].cleanup_failed);
    let info = harness.service.unload("test".into()).await.unwrap();
    assert_eq!(info.state, PluginState::Unloaded);
    assert!(info.cleanup_failed);
    assert!(harness.service.list().is_empty());
    assert!(harness.app.session_definitions().1.is_empty());
    let reloaded = harness.service.load("test".into()).await.unwrap();
    assert_ne!(reloaded.generation, info.generation);
    let next = harness.open("新代际不受旧告警封锁");
    provider.control(3).finish(completed(1));
    assert_eq!(
        finished(&harness.app, &next.id).await.generation,
        reloaded.generation
    );
    assert!(provider.unresolved.load(Ordering::SeqCst));
    assert_eq!(
        serde_json::to_value(harness.app.session(&first.id).unwrap()).unwrap(),
        serde_json::to_value(failed).unwrap()
    );
    harness.stop().await;
}

#[tokio::test]
async fn shutdown_closes_new_admission_revokes_input_and_waits_for_real_cleanup() {
    let provider = Provider::standard();
    provider.hold_cleanup.store(true, Ordering::SeqCst);
    let (harness, _) = Harness::loaded(provider.clone()).await;
    let opened = harness.open("服务关闭");
    let control = provider.control(0);
    status(&harness.app, &opened.id, SessionStatus::Running).await;
    let shutting_down = {
        let app = harness.app.clone();
        tokio::spawn(async move { app.shutdown().await })
    };
    control.wait_cancelled().await;
    status(&harness.app, &opened.id, SessionStatus::Stopping).await;
    assert!(!shutting_down.is_finished());
    assert!(control.input.cancel_calls.load(Ordering::SeqCst) > 0);
    assert!(control.input.send(b"revoked").await.is_err());
    assert!(control.input.eof().await.is_err());
    assert!(matches!(
        harness
            .app
            .open_session(OPERATION, json!({"label":"关闭后"})),
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        harness.app.session_remove(&opened.id),
        Err(Error::Conflict(_))
    ));
    assert_eq!(provider.opens.load(Ordering::SeqCst), 1);
    assert_eq!(provider.exits.load(Ordering::SeqCst), 0);
    control.finish(completed(1));
    tokio::time::timeout(Duration::from_secs(3), shutting_down)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(control.supervisor_finished.load(Ordering::SeqCst));
    assert_eq!(provider.exits.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.app.session(&opened.id).unwrap().status,
        SessionStatus::Finished
    );
    assert!(matches!(
        harness
            .app
            .open_session(OPERATION, json!({"label":"关闭终态后"})),
        Err(Error::Conflict(_))
    ));
    harness.app.session_remove(&opened.id).unwrap();
    harness.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn immediate_unload_registers_not_yet_polled_opening_supervisor() {
    let provider = Provider::standard();
    provider.ready_on_open.store(false, Ordering::SeqCst);
    let (harness, loaded) = Harness::loaded(provider.clone()).await;
    let opened = harness.open("打开即卸载");
    assert_eq!(provider.starts.load(Ordering::SeqCst), 0);
    assert_eq!(opened.status, SessionStatus::Opening);
    let unloaded = tokio::time::timeout(
        Duration::from_secs(3),
        harness.service.unload("test".into()),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(unloaded.state, PluginState::Unloaded);
    assert_eq!(unloaded.generation, loaded.generation);
    assert_eq!(provider.starts.load(Ordering::SeqCst), 1);
    assert_eq!(provider.exits.load(Ordering::SeqCst), 1);
    assert!(
        provider
            .control(0)
            .supervisor_finished
            .load(Ordering::SeqCst)
    );
    assert_eq!(
        harness.app.session(&opened.id).unwrap().status,
        SessionStatus::Finished
    );
    assert!(harness.app.session_definitions().1.is_empty());
    harness.stop().await;
}
