use super::*;

async fn deployed_version(router: &Router, kind: &str) -> String {
    let (status, headers, bytes) = request(
        router,
        "GET",
        &format!("/api/v2/plugin-packages/{kind}"),
        vec![],
        true,
        "application/json",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    envelope(&headers, &bytes)["data"][0]["version"]
        .as_str()
        .unwrap()
        .into()
}

#[tokio::test]
async fn browser_update_checks_market_identity_and_preserves_previous_deployment_on_failure() {
    let harness = Harness::new("").await;
    let (status, _, _) = request(
        &harness.router,
        "POST",
        "/api/v2/plugin-packages/browser?format=zip&expected_id=httpdemo&expected_version=1.0.0",
        package(true, false),
        false,
        "application/zip",
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    for query in [
        "format=zip&expected_id=other",
        "format=zip&expected_version=3.0.0",
    ] {
        let (status, headers, bytes) = request(
            &harness.router,
            "PUT",
            &format!("/api/v2/plugin-packages/browser/httpdemo?{query}"),
            package_version(true, false, "2.0.0"),
            false,
            "application/zip",
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(envelope(&headers, &bytes)["error"]["code"], "invalid_input");
        assert_eq!(deployed_version(&harness.router, "browser").await, "1.0.0");
    }
    let (status, headers, bytes) = request(
        &harness.router,
        "PUT",
        "/api/v2/plugin-packages/browser/httpdemo?format=zip&expected_id=httpdemo&expected_version=2.0.0",
        package_version(true, false, "2.0.0"),
        false,
        "application/zip",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(envelope(&headers, &bytes)["data"]["version"], "2.0.0");
    for (body, expected) in [
        (package_version(true, false, "2.0.0"), StatusCode::CONFLICT),
        (b"invalid archive".to_vec(), StatusCode::BAD_REQUEST),
    ] {
        let (status, headers, bytes) = request(
            &harness.router,
            "PUT",
            "/api/v2/plugin-packages/browser/httpdemo?format=zip",
            body,
            false,
            "application/zip",
        )
        .await;
        assert_eq!(status, expected);
        assert!(envelope(&headers, &bytes)["error"].is_object());
        assert_eq!(deployed_version(&harness.router, "browser").await, "2.0.0");
    }
    harness.close().await;
}

#[tokio::test]
async fn server_update_requires_unloaded_owner_and_does_not_implicitly_enable_the_new_version() {
    let harness = Harness::new("").await;
    let (status, _, _) = request(
        &harness.router,
        "POST",
        "/api/v2/plugin-packages/server?format=zip",
        package(false, false),
        false,
        "application/zip",
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _, _) = request(
        &harness.router,
        "POST",
        "/api/v2/plugins/httpdemo/load",
        vec![],
        false,
        "application/json",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, headers, bytes) = request(
        &harness.router,
        "PUT",
        "/api/v2/plugin-packages/server/httpdemo?format=zip&expected_version=2.0.0",
        package_version(false, false, "2.0.0"),
        false,
        "application/zip",
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(envelope(&headers, &bytes)["error"]["code"], "conflict");
    assert_eq!(deployed_version(&harness.router, "server").await, "1.0.0");
    assert!(!harness.app.operations().is_empty());
    let (status, _, _) = request(
        &harness.router,
        "POST",
        "/api/v2/plugins/httpdemo/unload",
        vec![],
        false,
        "application/json",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, headers, bytes) = request(
        &harness.router,
        "PUT",
        "/api/v2/plugin-packages/server/httpdemo?format=zip&expected_version=2.0.0",
        package_version(false, false, "2.0.0"),
        false,
        "application/zip",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(envelope(&headers, &bytes)["data"]["version"], "2.0.0");
    assert!(harness.app.operations().is_empty());
    assert!(harness.plugins.list().is_empty());
    harness.close().await;
}

#[tokio::test]
async fn update_honors_optional_authentication_and_rejects_cross_package_publication() {
    let harness = Harness::new("test-token").await;
    let (status, _, _) = request(
        &harness.router,
        "PUT",
        "/api/v2/plugin-packages/browser/httpdemo?format=zip",
        package(true, false),
        false,
        "application/zip",
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, headers, bytes) = request(
        &harness.router,
        "PUT",
        "/api/v2/plugin-packages/browser/other?format=zip",
        package(true, false),
        true,
        "application/zip",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(envelope(&headers, &bytes)["error"]["code"], "invalid_input");
    let (status, headers, bytes) = request(
        &harness.router,
        "GET",
        "/api/v2/plugin-packages/browser",
        vec![],
        true,
        "application/json",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(envelope(&headers, &bytes)["data"], json!([]));
    harness.close().await;
}
