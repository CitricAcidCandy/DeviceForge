mod mcp_notifications_fixtures;

use axum::http::StatusCode;
use futures_util::StreamExt;
use mcp_notifications_fixtures::*;
use serde_json::json;
use std::time::Duration;

#[tokio::test]
async fn dynamic_contributions_notify_and_invalidate_old_pagination() {
    let (app, plugins, router, shutdown) = setup("");
    let (mut events, log_id) = subscription(&router, "").await;
    invalidation(&mut events, &log_id).await;
    plugins.seed(contribution(101, true)).await.unwrap();
    invalidation(&mut events, &log_id).await;
    let first = json_result(request(&router, "tools/list", json!({}), "").await).await;
    assert_eq!(first["result"]["tools"].as_array().unwrap().len(), 100);
    let cursor = first["result"]["nextCursor"].as_str().unwrap().to_owned();
    let second =
        json_result(request(&router, "tools/list", json!({"cursor":cursor}), "").await).await;
    assert!(
        second["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "plugin.test.live")
    );
    assert!(plugins.seed(contribution(1, false)).await.is_err());
    assert!(
        tokio::time::timeout(Duration::from_millis(25), events.next())
            .await
            .is_err()
    );
    plugins.unload("test".into()).await.unwrap();
    invalidation(&mut events, &log_id).await;
    let stale =
        json_result(request(&router, "tools/list", json!({"cursor":cursor}), "").await).await;
    assert_eq!(stale["error"]["code"], -32602);
    assert!(stale["error"]["data"]["log_id"].is_string());
    let current = json_result(request(&router, "tools/list", json!({}), "").await).await;
    assert!(
        current["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|tool| !tool["name"].as_str().unwrap().starts_with("plugin.test."))
    );
    drop(events);
    shutdown.cancel();
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn session_only_plugins_use_the_same_directory_revision() {
    let (app, plugins, router, shutdown) = setup("");
    let mut changes = app.subscribe_contributions();
    let (mut events, log_id) = subscription(&router, "").await;
    invalidation(&mut events, &log_id).await;
    plugins.seed(contribution(0, true)).await.unwrap();
    assert!(changes.has_changed().unwrap());
    assert_eq!(*changes.borrow_and_update(), 1);
    invalidation(&mut events, &log_id).await;
    let current = json_result(request(&router, "tools/list", json!({}), "").await).await;
    assert!(
        current["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "plugin.test.live")
    );
    plugins.unload("test".into()).await.unwrap();
    assert_eq!(*changes.borrow_and_update(), 2);
    invalidation(&mut events, &log_id).await;
    drop(events);
    shutdown.cancel();
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn subscription_reconnect_receives_acknowledgment_and_initial_invalidation() {
    let (app, _, router, shutdown) = setup("");
    let (mut first, first_log_id) = subscription(&router, "").await;
    invalidation(&mut first, &first_log_id).await;
    drop(first);

    let (mut second, second_log_id) = subscription(&router, "").await;
    invalidation(&mut second, &second_log_id).await;
    drop(second);
    shutdown.cancel();
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn subscriptions_share_authentication_filtering_and_shutdown() {
    let (app, plugins, router, shutdown) = setup("test-notification-token");
    let denied = request(
        &router,
        "subscriptions/listen",
        json!({"notifications":{"toolsListChanged":true}}),
        "",
    )
    .await;
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let filtered = request(
        &router,
        "subscriptions/listen",
        json!({"notifications":{"promptsListChanged":true}}),
        "test-notification-token",
    )
    .await;
    let mut filtered_events: Events = Box::pin(filtered.into_body().into_data_stream());
    let acknowledgment = event(&mut filtered_events).await;
    assert_eq!(acknowledgment["params"]["notifications"], json!({}));
    let (mut accepted_events, log_id) = subscription(&router, "test-notification-token").await;
    invalidation(&mut accepted_events, &log_id).await;
    plugins.seed(contribution(1, false)).await.unwrap();
    invalidation(&mut accepted_events, &log_id).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(25), filtered_events.next())
            .await
            .is_err()
    );
    shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(frame) = accepted_events.next().await {
            frame.unwrap();
        }
        while let Some(frame) = filtered_events.next().await {
            frame.unwrap();
        }
    })
    .await
    .unwrap();
    app.shutdown().await.unwrap();
}

#[tokio::test]
async fn subscription_capacity_recovers_after_client_disconnect() {
    let (app, _, router, shutdown) = setup("");
    let mut opened = Vec::new();
    for _ordinal in 0..32 {
        let (mut events, log_id) = subscription(&router, "").await;
        invalidation(&mut events, &log_id).await;
        opened.push(events);
    }
    let (mut rejected, log_id) = subscription(&router, "").await;
    let error = event(&mut rejected).await;
    assert_eq!(error["error"]["code"], -32603);
    assert_eq!(error["error"]["data"]["log_id"], log_id);
    drop(rejected);
    drop(opened.pop());
    let replacement = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let (mut events, _) = subscription(&router, "").await;
            let message = event(&mut events).await;
            if message["method"] == "notifications/tools/list_changed" {
                break events;
            }
            assert_eq!(message["error"]["code"], -32603);
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(replacement);
    drop(opened);
    shutdown.cancel();
    app.shutdown().await.unwrap();
}
