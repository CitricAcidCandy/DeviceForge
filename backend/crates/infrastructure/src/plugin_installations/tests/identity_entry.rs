//! 单清单生成的点文件入口须贯通完整发布更新、清单验证及原字节读取。
use super::*;

fn generated_release(build: &str) -> Vec<u8> {
    let version = "1.0.0";
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
        (
            "plugin.json",
            serde_json::to_vec(&json!({"id":"identity_browser","version":version,"api_version":2}))
                .unwrap(),
        ),
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
    let manifest = json!({"format_version":2,"host_api_version":2,"id":"identity_release","version":version,
        "name":"身份入口回归","description":"单清单浏览器组件更新",
        "components":[{"id":"identity_browser","kind":"browser","version":version,"variants":[{
            "platform":"any","path":path,"sha256":digest,"size":component.len(),"format":"tgz"}]}],
        "dependencies":{"format_version":1,"dependencies":[]}});
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
