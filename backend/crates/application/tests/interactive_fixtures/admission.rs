use super::{
    provider::{OPERATION, Provider, definition},
    support::Harness,
    transport::completed,
};
use apk_domain::{
    Error,
    interactive::{SessionProvider, SessionStatus},
    plugins::PluginState,
};
use serde_json::json;
use std::{sync::atomic::Ordering, time::Instant};

#[tokio::test]
async fn session_only_plugin_registers_and_invalid_schema_never_opens_transport() {
    let provider = Provider::standard();
    let (harness, loaded) = Harness::loaded(provider.clone()).await;
    assert_eq!(loaded.state, PluginState::Loaded);
    assert!(harness.app.operations().is_empty());
    let (_, definitions) = harness.app.session_definitions();
    assert_eq!(definitions.len(), 1);
    assert_eq!(definitions[0].id, OPERATION);
    assert!(harness.app.list(10).unwrap().is_empty());
    assert!(harness.app.session_records().is_empty());
    for input in [
        json!(null),
        json!([]),
        json!({}),
        json!({"label":5}),
        json!({"label":""}),
        json!({"label":"有效","extra":true}),
    ] {
        assert!(matches!(
            harness.app.open_session(OPERATION, input),
            Err(Error::Invalid(_))
        ));
    }
    assert!(matches!(
        harness
            .app
            .open_session("plugin.test.missing", json!({"label":"有效"})),
        Err(Error::NotFound(_))
    ));
    assert_eq!(provider.opens.load(Ordering::SeqCst), 0);
    assert_eq!(provider.starts.load(Ordering::SeqCst), 0);
    assert_eq!(harness.executor.regular_calls.load(Ordering::SeqCst), 0);
    assert!(harness.app.session_records().is_empty());
    assert!(harness.app.list(10).unwrap().is_empty());
    harness.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn synchronous_admission_keeps_identity_and_does_not_poll_supervisor_inline() {
    let provider = Provider::standard();
    provider.ready_on_open.store(false, Ordering::SeqCst);
    let (harness, loaded) = Harness::loaded(provider.clone()).await;
    let before = Instant::now();
    let info = harness.open("纯准入");
    let after = Instant::now();
    assert_eq!(info.status, SessionStatus::Opening);
    assert_eq!(info.output_sequence, 0);
    assert!(info.completion.is_none());
    assert_eq!(info.plugin_id, loaded.id);
    assert_eq!(info.generation, loaded.generation);
    assert_eq!(info.operation, OPERATION);
    assert!(!info.id.is_empty());
    assert!(info.created_at > 0);
    assert_eq!(provider.opens.load(Ordering::SeqCst), 1);
    assert_eq!(provider.starts.load(Ordering::SeqCst), 0);
    {
        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests[0].session_id, info.id);
        assert_eq!(requests[0].operation, OPERATION);
        assert_eq!(requests[0].input, json!({"label":"纯准入"}));
        assert!(requests[0].deadline > before);
        assert!(requests[0].deadline > after);
    }
    let control = provider.control(0);
    control.mark_ready();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while harness.app.session(&info.id).unwrap().status != SessionStatus::Running {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(provider.starts.load(Ordering::SeqCst), 1);
    control.finish(completed(1));
    super::support::finished(&harness.app, &info.id).await;
    assert_eq!(provider.exits.load(Ordering::SeqCst), 1);
    harness.stop().await;
}

#[tokio::test]
async fn invalid_session_contribution_is_not_partially_published() {
    for invalid in [
        definition("other.live"),
        definition("plugin.test.Uppercase"),
    ] {
        let provider = Provider::new(vec![definition(OPERATION), invalid]);
        let harness = Harness::new(provider.clone());
        assert!(matches!(
            harness.service.load("test".into()).await,
            Err(Error::Invalid(_))
        ));
        assert!(harness.app.session_definitions().1.is_empty());
        assert!(harness.service.list().is_empty());
        assert_eq!(provider.opens.load(Ordering::SeqCst), 0);
        harness.stop().await;
    }
    let mut invalid = definition("plugin.test.second");
    invalid.input_schema =
        json!({"type":"object","properties":{"field":{"$ref":"https://example.invalid/schema"}}});
    let provider = Provider::new(vec![definition(OPERATION), invalid]);
    let harness = Harness::new(provider.clone());
    assert!(matches!(
        harness.service.load("test".into()).await,
        Err(Error::Invalid(_))
    ));
    assert!(harness.app.session_definitions().1.is_empty());
    assert_eq!(provider.opens.load(Ordering::SeqCst), 0);
    assert!(!provider.has_unresolved_resources());
    harness.stop().await;
}
