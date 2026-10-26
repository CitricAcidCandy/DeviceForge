//! 真实路由校验发布顺序、浏览器能力探测和永久版本身份，不启动监听端口。
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode, header},
    response::Response,
};
use deviceforge_resource_server::{ResourceRecord, Store, router};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

async fn request(app: &Router, method: Method, uri: &str, value: Option<&Value>) -> Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::HOST, "market.invalid")
                .header(header::ORIGIN, "http://127.0.0.1:5173")
                .body(value.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn decode(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}

async fn upload(app: &Router, bytes: &[u8]) -> ResourceRecord {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/resources")
                .header("x-resource-filename", "component.bin")
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .body(Body::from(bytes.to_vec()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    serde_json::from_value(decode(response).await).unwrap()
}

fn manifest() -> Value {
    let component = format!("{:x}", Sha256::digest(b"component"));
    let tool = format!("{:x}", Sha256::digest(b"tool"));
    json!({
        "format_version":1,"host_api_version":2,"id":"third-party","version":"1.0.0",
        "name":"第三方功能","description":"完整功能发布",
        "components":[{"id":"third-party","kind":"server","version":"1.0.0",
            "variants":[{"platform":"any","path":component,"sha256":component,"size":9,"format":"zip"}]}],
        "tools":[{"id":"runtime","version":"1.0.0","required":true,"bindings":[],
            "variants":[{"platform":"any","path":tool,"sha256":tool,"size":4,
                "format":"file","entries":{"main":"payload"}}]}]
    })
}

async fn entry(app: &Router, manifest: &Value) -> Value {
    let resource = upload(app, &serde_json::to_vec(manifest).unwrap()).await;
    json!({"metadata_version":1,"id":"third-party","kind":"plugin","name":"第三方功能",
        "version":"1.0.0","summary":"完整发布","description":"发布测试",
        "applies_to":["deviceforge"],"supports_mcp":"none","supports_agent":false,
        "restart_policy":"plugin_reload","resource_id":resource.sha256,
        "details":{"release_format_version":manifest["format_version"],"host_api_version":2}})
}

async fn catalog_count(app: &Router) -> u64 {
    decode(request(app, Method::GET, "/api/v1/catalog", None).await).await["total"]
        .as_u64()
        .unwrap()
}

async fn assert_unpublished(app: &Router, entry: &Value, status: StatusCode) {
    let response = request(app, Method::POST, "/api/v1/catalog", Some(entry)).await;
    assert_eq!(response.status(), status);
    assert_eq!(catalog_count(app).await, 0);
}

fn variant(bytes: &[u8], platform: &str, tool: bool) -> Value {
    let digest = format!("{:x}", Sha256::digest(bytes));
    let mut value = json!({"platform":platform,"path":digest,"sha256":digest,
        "size":bytes.len(),"format":if tool { "file" } else { "zip" }});
    if tool {
        value["entries"] = json!({"main":"payload"});
    }
    value
}

fn second_version(source: Value) -> Value {
    let mut value = manifest();
    value["format_version"] = json!(2);
    value["tools"] = json!([]);
    value["dependencies"] = json!({"format_version":1,"dependencies":[{
        "id":"third-party-runtime","name":"第三方工具","version_requirement":"^1.0.0",
        "entries":["main"],"sources":[source],
        "bindings":[{"component_id":"third-party","config_pointer":"/executable","entry":"main"}]
    }]});
    value
}

fn dependency_source(kind: &str, url: &str) -> Value {
    json!({"kind":kind,"url":url,"platform":"any","version":"1.0.0",
        "sha256":format!("{:x}",Sha256::digest(b"runtime")),"size":7,
        "format":"file","entries":{"main":"payload"}})
}

#[tokio::test]
async fn second_version_official_https_needs_metadata_not_uploaded_tool() {
    let directory = tempfile::tempdir().unwrap();
    let app = router(Store::open(directory.path()).unwrap());
    upload(&app, b"component").await;
    let value = second_version(dependency_source(
        "official",
        "https://upstream.invalid/runtime.bin",
    ));
    let catalog = entry(&app, &value).await;
    let response = request(&app, Method::POST, "/api/v1/catalog", Some(&catalog)).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(catalog_count(&app).await, 1);
}

#[tokio::test]
async fn second_version_market_waits_for_matching_digest_and_retains_distinct_revisions() {
    let directory = tempfile::tempdir().unwrap();
    let app = router(Store::open(directory.path()).unwrap());
    upload(&app, b"component").await;
    let digest = format!("{:x}", Sha256::digest(b"runtime"));
    let mut value = second_version(dependency_source(
        "market",
        &format!("https://market.invalid/api/v1/resources/{digest}"),
    ));
    let mut official = dependency_source("official", "https://upstream.invalid/other-runtime.bin");
    official["sha256"] = json!("b".repeat(64));
    value["dependencies"]["dependencies"][0]["sources"]
        .as_array_mut()
        .unwrap()
        .push(official);
    let catalog = entry(&app, &value).await;
    assert_unpublished(&app, &catalog, StatusCode::NOT_FOUND).await;
    upload(&app, b"runtime").await;
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&catalog))
            .await
            .status(),
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn second_version_rejects_insecure_or_incomplete_sources_and_marker_mismatch() {
    for change in [
        "http",
        "size",
        "entries",
        "marker",
        "credentials",
        "placeholder",
        "file_entry",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let app = router(Store::open(directory.path()).unwrap());
        upload(&app, b"component").await;
        let mut value = second_version(dependency_source(
            "official",
            "https://upstream.invalid/runtime.bin",
        ));
        let source = &mut value["dependencies"]["dependencies"][0]["sources"][0];
        match change {
            "http" => source["url"] = json!("http://upstream.invalid/runtime.bin"),
            "size" => source["size"] = json!(0),
            "entries" => source["entries"] = json!({}),
            "placeholder" => source["sha256"] = json!("0".repeat(64)),
            "file_entry" => source["entries"] = json!({"main":"other.bin"}),
            "credentials" => {
                source["url"] = json!("https://user:secret@upstream.invalid/runtime.bin")
            }
            _ => (),
        }
        let mut catalog = entry(&app, &value).await;
        if change == "marker" {
            catalog["details"]["release_format_version"] = json!(1);
        }
        assert_unpublished(&app, &catalog, StatusCode::BAD_REQUEST).await;
    }
}

#[tokio::test]
async fn second_version_market_rejects_foreign_or_offline_urls_even_with_local_blob() {
    let digest = format!("{:x}", Sha256::digest(b"runtime"));
    for url in [
        format!("https://other.invalid/api/v1/resources/{digest}"),
        format!("https://market.invalid:7041/api/v1/resources/{digest}"),
        format!("blobs/{digest}"),
        format!("https://market.invalid/api/v1/resources/{digest}?download=1"),
        format!("https://market.invalid/api/v1/resources/{}", "f".repeat(64)),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let app = router(Store::open(directory.path()).unwrap());
        upload(&app, b"component").await;
        upload(&app, b"runtime").await;
        let value = second_version(dependency_source("market", &url));
        let catalog = entry(&app, &value).await;
        assert_unpublished(&app, &catalog, StatusCode::BAD_REQUEST).await;
        // 来源失败不占用版本身份，修正清单可以使用同一 ID/版本发布。
        let fixed = second_version(dependency_source("market", &digest));
        let fixed = entry(&app, &fixed).await;
        assert_eq!(
            request(&app, Method::POST, "/api/v1/catalog", Some(&fixed))
                .await
                .status(),
            StatusCode::CREATED
        );
    }
}

#[tokio::test]
async fn second_version_market_checks_real_dependency_bytes_and_size() {
    for corrupt_bytes in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let app = router(store.clone());
        upload(&app, b"component").await;
        let resource = upload(&app, b"runtime").await;
        let mut value = second_version(dependency_source("market", &resource.sha256));
        if corrupt_bytes {
            std::fs::write(store.resource_path(&resource).unwrap(), b"corrupt").unwrap();
        } else {
            value["dependencies"]["dependencies"][0]["sources"][0]["size"] = json!(8);
        }
        let catalog = entry(&app, &value).await;
        assert_unpublished(&app, &catalog, StatusCode::BAD_REQUEST).await;
    }
}

#[tokio::test]
async fn capabilities_get_head_and_cors_preflight_are_read_only() {
    let directory = tempfile::tempdir().unwrap();
    let app = router(Store::open(directory.path()).unwrap());
    let response = request(&app, Method::GET, "/api/v1/capabilities", None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    let get_headers = response.headers().clone();
    assert_eq!(get_headers[header::CONTENT_TYPE], "application/json");
    assert!(get_headers.contains_key(header::CONTENT_LENGTH));
    assert_eq!(
        decode(response).await,
        json!({
            "api_version":1,"release_publication":{"format_versions":[1,2],"host_api_versions":[2],
                "resource_max_bytes":2147483648_u64,"catalog_last":true,"immutable_versions":true}
        })
    );
    let response = request(&app, Method::HEAD, "/api/v1/capabilities", None).await;
    assert_eq!(response.status(), StatusCode::OK);
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
    ] {
        assert_eq!(response.headers().get(&name), get_headers.get(&name));
    }
    assert!(
        to_bytes(response.into_body(), 1024)
            .await
            .unwrap()
            .is_empty()
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/api/v1/resources")
                .header(header::ORIGIN, "http://127.0.0.1:5173")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                .header(
                    header::ACCESS_CONTROL_REQUEST_HEADERS,
                    "content-type,x-resource-filename,x-resource-filename-encoding,x-resource-kind",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(response.status().is_success());
    assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    assert!(
        response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_HEADERS)
    );
    for (uri, method, headers) in [
        ("/api/v1/capabilities", "HEAD", "content-type"),
        ("/api/v1/catalog", "POST", "content-type"),
        ("/api/v1/resources/unused", "HEAD", "range,if-none-match"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri(uri)
                    .header(header::ORIGIN, "http://127.0.0.1:5173")
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, method)
                    .header(header::ACCESS_CONTROL_REQUEST_HEADERS, headers)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_success());
        for name in [
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            header::ACCESS_CONTROL_ALLOW_METHODS,
            header::ACCESS_CONTROL_ALLOW_HEADERS,
        ] {
            assert_eq!(response.headers()[name], "*");
        }
    }
    assert_eq!(catalog_count(&app).await, 0);
    for category in ["blobs", "tmp"] {
        assert_eq!(
            std::fs::read_dir(directory.path().join(category))
                .unwrap()
                .count(),
            0
        );
    }
}

#[tokio::test]
async fn catalog_waits_for_complete_resources_and_head_preserves_browser_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    let app = router(store.clone());
    let entry = entry(&app, &manifest()).await;
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&entry))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(catalog_count(&app).await, 0);
    let component = upload(&app, b"component").await;
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&entry))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(catalog_count(&app).await, 0);
    let tool = upload(&app, b"tool").await;
    std::fs::write(store.resource_path(&tool).unwrap(), b"x").unwrap();
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&entry))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(catalog_count(&app).await, 0);
    std::fs::write(store.resource_path(&tool).unwrap(), b"tool").unwrap();
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&entry))
            .await
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(catalog_count(&app).await, 1);
    let response = request(
        &app,
        Method::HEAD,
        &format!("/api/v1/resources/{}", component.sha256),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_LENGTH], "9");
    assert_eq!(
        response.headers()[header::ETAG],
        format!("\"{}\"", component.sha256)
    );
    assert_eq!(
        response.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS],
        "*"
    );
    assert!(
        to_bytes(response.into_body(), 1024)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn malformed_markers_and_mismatched_identity_never_publish() {
    let directory = tempfile::tempdir().unwrap();
    let app = router(Store::open(directory.path()).unwrap());
    upload(&app, b"component").await;
    upload(&app, b"tool").await;
    let original = entry(&app, &manifest()).await;
    for details in [
        json!({"host_api_version":2}),
        json!({"release_format_version":1}),
        json!({"release_format_version":null,"host_api_version":2}),
        json!({"release_format_version":1,"host_api_version":1}),
        json!({"release_format_version":"1","host_api_version":2}),
        json!({"release_format_version":2,"host_api_version":2}),
        json!({"release_format_version":true,"host_api_version":2}),
        json!({"release_format_version":1.0,"host_api_version":2}),
        json!({"release_format_version":1,"host_api_version":"2"}),
        json!({"release_format_version":1,"host_api_version":null}),
    ] {
        let mut entry = original.clone();
        entry["details"] = details;
        assert_eq!(
            request(&app, Method::POST, "/api/v1/catalog", Some(&entry))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(catalog_count(&app).await, 0);
    }
    for (field, value) in [
        ("name", "另一功能"),
        ("id", "other"),
        ("version", "2.0.0"),
        ("kind", "resource"),
    ] {
        let mut entry = original.clone();
        entry[field] = json!(value);
        assert_eq!(
            request(&app, Method::POST, "/api/v1/catalog", Some(&entry))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(catalog_count(&app).await, 0);
    }
    let mut incompatible = manifest();
    incompatible["components"][0]["variants"][0]["path"] = json!("elsewhere/component.zip");
    let invalid_path = entry(&app, &incompatible).await;
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&invalid_path))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn immutable_identity_survives_deletion_restart_and_legacy_downgrade() {
    let directory = tempfile::tempdir().unwrap();
    let app = router(Store::open(directory.path()).unwrap());
    upload(&app, b"component").await;
    upload(&app, b"tool").await;
    let original = entry(&app, &manifest()).await;
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&original))
            .await
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&original))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            "/api/v1/catalog/third-party/1.0.0",
            None
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    drop(app);
    let app = router(Store::open(directory.path()).unwrap());
    let mut changed = manifest();
    changed["description"] = json!("新字节");
    let changed = entry(&app, &changed).await;
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&changed))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let mut legacy = original.clone();
    legacy["details"] = json!({});
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&legacy))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(catalog_count(&app).await, 0);
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&original))
            .await
            .status(),
        StatusCode::CREATED
    );
    // 从未绑定完整发布身份的旧条目仍保留兼容提交入口。
    legacy["id"] = json!("legacy");
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&legacy))
            .await
            .status(),
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn equal_length_component_and_tool_corruption_never_publishes() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    let app = router(store.clone());
    let component = upload(&app, b"component").await;
    let tool = upload(&app, b"tool").await;
    let original = entry(&app, &manifest()).await;
    for (resource, bytes) in [
        (&component, b"component".as_slice()),
        (&tool, b"tool".as_slice()),
    ] {
        let path = store.resource_path(resource).unwrap();
        let mut corrupt = bytes.to_vec();
        corrupt[0] ^= 1;
        std::fs::write(&path, corrupt).unwrap();
        assert_unpublished(&app, &original, StatusCode::BAD_REQUEST).await;
        std::fs::write(path, bytes).unwrap();
    }
    // 拒绝的目录提交不得提前绑定版本；修正后的另一清单可以占用首次身份。
    let mut corrected = manifest();
    corrected["description"] = json!("修复后首次正式发布");
    let corrected = entry(&app, &corrected).await;
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&corrected))
            .await
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(catalog_count(&app).await, 1);
}

#[tokio::test]
async fn component_digest_covers_bytes_after_the_first_streaming_chunk() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    let app = router(store.clone());
    let bytes = vec![b'c'; 128 * 1024 + 17];
    let resource = upload(&app, &bytes).await;
    let mut release = manifest();
    release["components"][0]["variants"] = json!([variant(&bytes, "any", false)]);
    release["tools"] = json!([]);
    let entry = entry(&app, &release).await;
    let path = store.resource_path(&resource).unwrap();
    let mut corrupt = bytes.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    std::fs::write(&path, corrupt).unwrap();
    assert_unpublished(&app, &entry, StatusCode::BAD_REQUEST).await;
    std::fs::write(path, bytes).unwrap();
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&entry))
            .await
            .status(),
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn every_component_platform_and_optional_tool_is_required_before_catalog_commit() {
    let directory = tempfile::tempdir().unwrap();
    let app = router(Store::open(directory.path()).unwrap());
    let mut release = manifest();
    release["components"][0]["variants"] = json!([
        variant(b"component", "win32-x64", false),
        variant(b"component-linux", "linux-x64", false)
    ]);
    release["components"].as_array_mut().unwrap().push(json!({
        "id":"browser-ui","kind":"browser","version":"1.0.0",
        "variants":[variant(b"browser", "any", false)]
    }));
    release["tools"][0]["variants"] = json!([
        variant(b"tool", "win32-x64", true),
        variant(b"tool-linux", "linux-x64", true)
    ]);
    release["tools"].as_array_mut().unwrap().push(json!({
        "id":"optional-runtime","version":"1.0.0","required":false,
        "variants":[variant(b"optional", "android-arm64", true)]
    }));
    let entry = entry(&app, &release).await;
    for bytes in [
        b"component".as_slice(),
        b"component-linux",
        b"browser",
        b"tool",
        b"tool-linux",
        b"optional",
    ] {
        assert_unpublished(&app, &entry, StatusCode::NOT_FOUND).await;
        upload(&app, bytes).await;
    }
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&entry))
            .await
            .status(),
        StatusCode::CREATED
    );
    // 内部组件与工具只作为资源存在，不额外产生功能卡片。
    assert_eq!(catalog_count(&app).await, 1);
}

#[tokio::test]
async fn component_and_tool_references_require_local_digests_and_matching_lengths() {
    let directory = tempfile::tempdir().unwrap();
    let app = router(Store::open(directory.path()).unwrap());
    upload(&app, b"component").await;
    upload(&app, b"tool").await;
    for pointer in ["/components/0/variants/0", "/tools/0/variants/0"] {
        for path in [
            "other/resource.bin",
            "/api/v1/resources/local",
            "https://elsewhere.invalid/resource",
        ] {
            let mut release = manifest();
            release.pointer_mut(pointer).unwrap()["path"] = json!(path);
            let entry = entry(&app, &release).await;
            assert_unpublished(&app, &entry, StatusCode::BAD_REQUEST).await;
        }
        let mut release = manifest();
        let variant = release.pointer_mut(pointer).unwrap();
        variant["size"] = json!(variant["size"].as_u64().unwrap() + 1);
        let entry = entry(&app, &release).await;
        assert_unpublished(&app, &entry, StatusCode::BAD_REQUEST).await;
    }
    // 同一内容允许被多个组件或工具复用，但每一处声明的长度仍需一致。
    let mut shared = manifest();
    shared["components"].as_array_mut().unwrap().push(json!({
        "id":"shared-browser","kind":"browser","version":"1.0.0",
        "variants":[variant(b"component", "any", false)]
    }));
    shared["tools"][0]["variants"][0] = variant(b"component", "any", true);
    shared["tools"][0]["variants"][0]["size"] = json!(8);
    let invalid = entry(&app, &shared).await;
    assert_unpublished(&app, &invalid, StatusCode::BAD_REQUEST).await;
    shared["tools"][0]["variants"][0]["size"] = json!(9);
    let valid = entry(&app, &shared).await;
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&valid))
            .await
            .status(),
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn manifest_corruption_and_size_mismatch_never_publish() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    let app = router(store.clone());
    upload(&app, b"component").await;
    upload(&app, b"tool").await;
    let release = manifest();
    let original = entry(&app, &release).await;
    let resource = store
        .resource(original["resource_id"].as_str().unwrap())
        .unwrap();
    let path = store.resource_path(&resource).unwrap();
    let bytes = serde_json::to_vec(&release).unwrap();
    let mut changed = release.clone();
    changed["description"] = json!("篡改功能发布");
    let changed = serde_json::to_vec(&changed).unwrap();
    assert_eq!(bytes.len(), changed.len());
    for corrupt in [
        changed,
        bytes[..bytes.len() - 1].to_vec(),
        vec![b'x'; 256 * 1024 + 1],
    ] {
        std::fs::write(&path, corrupt).unwrap();
        assert_unpublished(&app, &original, StatusCode::BAD_REQUEST).await;
    }
    std::fs::write(path, bytes).unwrap();
    let mut oversized = release;
    oversized["description"] = json!("x".repeat(256 * 1024));
    let oversized = entry(&app, &oversized).await;
    assert_unpublished(&app, &oversized, StatusCode::BAD_REQUEST).await;
    assert_eq!(
        request(&app, Method::POST, "/api/v1/catalog", Some(&original))
            .await
            .status(),
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn resource_get_head_ranges_and_conditional_headers_remain_compatible() {
    let directory = tempfile::tempdir().unwrap();
    let app = router(Store::open(directory.path()).unwrap());
    let resource = upload(&app, b"component").await;
    let uri = format!("/api/v1/resources/{}", resource.sha256);
    let etag = format!("\"{}\"", resource.sha256);
    for method in [Method::GET, Method::HEAD] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method.clone())
                    .uri(&uri)
                    .header(header::ORIGIN, "http://127.0.0.1:5173")
                    .header(header::RANGE, "bytes=1-3")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "3");
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 1-3/9");
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert_eq!(response.headers()[header::ETAG], etag);
        assert_eq!(response.headers()["x-resource-filename"], "component.bin");
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS],
            "*"
        );
        let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(
            bytes.as_ref(),
            if method == Method::HEAD {
                b"".as_slice()
            } else {
                b"omp".as_slice()
            }
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(&uri)
                    .header(header::IF_NONE_MATCH, &etag)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(response.headers()[header::ETAG], etag);
        assert!(
            to_bytes(response.into_body(), 1024)
                .await
                .unwrap()
                .is_empty()
        );
    }
    let empty = upload(&app, b"").await;
    let response = request(
        &app,
        Method::HEAD,
        &format!("/api/v1/resources/{}", empty.sha256),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_LENGTH], "0");
    assert!(
        to_bytes(response.into_body(), 1024)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn resource_head_and_conditional_get_do_not_hide_missing_or_truncated_files() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    let app = router(store.clone());
    let resource = upload(&app, b"component").await;
    let path = store.resource_path(&resource).unwrap();
    let uri = format!("/api/v1/resources/{}", resource.sha256);
    let etag = format!("\"{}\"", resource.sha256);
    std::fs::write(&path, b"x").unwrap();
    for expected in [StatusCode::INTERNAL_SERVER_ERROR, StatusCode::NOT_FOUND] {
        for method in [Method::GET, Method::HEAD] {
            for conditional in [false, true] {
                let mut builder = Request::builder()
                    .method(method.clone())
                    .uri(&uri)
                    .header(header::ORIGIN, "http://127.0.0.1:5173");
                if conditional {
                    builder = builder.header(header::IF_NONE_MATCH, &etag);
                }
                let response = app
                    .clone()
                    .oneshot(builder.body(Body::empty()).unwrap())
                    .await
                    .unwrap();
                assert_eq!(response.status(), expected);
                assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
                if method == Method::HEAD {
                    assert!(
                        to_bytes(response.into_body(), 1024)
                            .await
                            .unwrap()
                            .is_empty()
                    );
                }
            }
        }
        if expected == StatusCode::INTERNAL_SERVER_ERROR {
            std::fs::remove_file(&path).unwrap();
        }
    }
}
