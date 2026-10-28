//! 单清单生成的点文件入口须贯通完整发布更新、清单验证及原字节读取。
use super::*;

fn generated_release(build: &str) -> Vec<u8> {
    generated_release_with_configuration(build, None)
}

fn generated_release_with_configuration(
    build: &str,
    configuration: Option<serde_json::Value>,
) -> Vec<u8> {
    let version = "1.0.0";
    let mut plugin = json!({"id":"identity_browser","version":version,"api_version":2});
    if let Some(configuration) = &configuration {
        plugin["configuration"] = configuration.clone();
    }
    let gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut archive = tar::Builder::new(gzip);
    for (path, bytes) in [
        (
            "package.json",
            serde_json::to_vec(&json!({"version":version,"deviceforge":{
            "kind":"browser","manifest":"plugin.json","entrypoints":{
                "any":{"runtime":"browser","path":".deviceforge-entry.js"}}}}))
            .unwrap(),
        ),
        ("plugin.json", serde_json::to_vec(&plugin).unwrap()),
        (
            ".deviceforge-entry.js",
            format!("export {{default}} from './index.js'; // 构建：{build}").into_bytes(),
        ),
        ("index.js", b"export default {panels:[]};".to_vec()),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive
            .append_data(&mut header, format!("package/{path}"), bytes.as_slice())
            .unwrap();
    }
    let component = archive.into_inner().unwrap().finish().unwrap();
    let digest = format!("{:x}", Sha256::digest(&component));
    let path = format!("blobs/{digest}");
    let mut manifest = json!({"format_version":2,"host_api_version":2,"id":"identity_release","version":version,
        "name":"身份入口回归","description":"单清单浏览器组件更新",
        "components":[{"id":"identity_browser","kind":"browser","version":version,"variants":[{
            "platform":"any","path":path,"sha256":digest,"size":component.len(),"format":"tgz"}]}],
        "dependencies":{"format_version":1,"dependencies":[]}});
    if configuration.is_some() {
        manifest["requirements"] = json!([{"component_id":"identity_browser","config_pointer":"/endpoint",
            "title":"配置地址","description":"由使用者填写实际地址","required":true}]);
    }
    zip(vec![
        ("release.json", serde_json::to_vec(&manifest).unwrap()),
        (
            "market.json",
            serde_json::to_vec(&json!({"metadata_version":1})).unwrap(),
        ),
        (&path, component),
    ])
}

#[tokio::test]
async fn original_package_with_missing_policy_and_required_user_input_installs_without_rewriting() {
    let (_temporary, artifacts, store) = setup().await;
    let configuration = json!({"version":1,"schema":{"type":"object",
        "properties":{"endpoint":{"type":"string","minLength":1}},"required":["endpoint"]},
        "defaults":{}});
    let source = upload(
        &artifacts,
        generated_release_with_configuration("draft", Some(configuration.clone())),
    )
    .await;
    let plan = store.plan(source.clone()).await.unwrap();
    let installed = store
        .prepare(source)
        .await
        .unwrap()
        .commit(None)
        .await
        .unwrap();
    assert_eq!(installed.revision, plan.revision);
    assert_eq!(installed.requirements.len(), 1);
    let asset = store
        .asset("identity_browser", &installed.revision, "plugin.json")
        .await
        .unwrap();
    let bytes = asset.stream.try_collect::<Vec<_>>().await.unwrap().concat();
    let preserved: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(preserved["configuration"], configuration);
    assert!(preserved["configuration"].get("apply_policy").is_none());
}

#[tokio::test]
async fn single_manifest_v2_update_installs_generated_tgz_and_serves_entry() {
    let (_temporary, artifacts, store) = setup().await;
    let first = store
        .prepare(upload(&artifacts, generated_release("first")).await)
        .await
        .unwrap()
        .commit(None)
        .await
        .unwrap();
    let second = store
        .prepare(upload(&artifacts, generated_release("second")).await)
        .await
        .unwrap()
        .commit(Some(first.revision.clone()))
        .await
        .unwrap();
    assert_eq!(second.components[0].entry_path, ".deviceforge-entry.js");
    assert_eq!(first.version, second.version);
    assert_ne!(first.revision, second.revision);
    for (revision, build) in [(&first.revision, "first"), (&second.revision, "second")] {
        let asset = store
            .asset("identity_browser", revision, ".deviceforge-entry.js")
            .await
            .unwrap();
        assert_eq!(asset.content_type, "text/javascript; charset=utf-8");
        assert_eq!(
            asset.stream.try_collect::<Vec<_>>().await.unwrap().concat(),
            format!("export {{default}} from './index.js'; // 构建：{build}").as_bytes()
        );
    }
}

#[tokio::test]
async fn single_manifest_v2_reinstall_accepts_previous_and_new_builds_after_uninstall() {
    let (_temporary, artifacts, store) = setup().await;
    let original = upload(&artifacts, generated_release("first")).await;
    let rebuilt = upload(&artifacts, generated_release("second")).await;
    let first = store
        .prepare(original.clone())
        .await
        .unwrap()
        .commit(None)
        .await
        .unwrap();
    let second = store
        .prepare(rebuilt.clone())
        .await
        .unwrap()
        .commit(Some(first.revision.clone()))
        .await
        .unwrap();
    store.delete(&second.id, &second.revision).await.unwrap();

    // 覆盖最后使用的包、新的同版本构建以及最初的包；重装不要求清除历史摘要。
    let new_build = upload(&artifacts, generated_release("third")).await;
    for (source, build) in [
        (rebuilt, "second"),
        (new_build, "third"),
        (original, "first"),
    ] {
        let plan = store.plan(source.clone()).await.unwrap();
        assert!(
            plan.issues.iter().all(|issue| !issue.required),
            "离线重装计划不应受历史版本锁阻断：{:?}",
            plan.issues
        );
        let installed = store
            .prepare(source)
            .await
            .unwrap()
            .commit(None)
            .await
            .unwrap();
        assert_eq!(installed.revision, plan.revision);
        assert_eq!(installed.version, first.version);
        let asset = store
            .asset(
                "identity_browser",
                &installed.revision,
                ".deviceforge-entry.js",
            )
            .await
            .unwrap();
        assert_eq!(
            asset.stream.try_collect::<Vec<_>>().await.unwrap().concat(),
            format!("export {{default}} from './index.js'; // 构建：{build}").as_bytes()
        );
        store
            .delete(&installed.id, &installed.revision)
            .await
            .unwrap();
    }
}
