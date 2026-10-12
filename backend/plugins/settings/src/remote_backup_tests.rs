//! 远端保存可跳过本地备份，但不跳过修订、跨进程锁或取消规则。
use super::{integration_tests::*, *};
use std::{fs, path::Path, time::Duration};
use tokio::{io::AsyncReadExt, net::TcpListener};

fn seed(root: &Path) -> (PathBuf, Vec<u8>) {
    let owner = root.join("users/demo");
    fs::create_dir_all(&owner).unwrap();
    let original =
        br#"{"format_version":1,"revision":"7","sections":{"deviceInfo":{"items":["old"]}}}"#
            .to_vec();
    let path = owner.join("settings.json");
    fs::write(&path, &original).unwrap();
    (path, original)
}

fn no_backup(revision: &str) -> Value {
    let mut value = input(revision);
    value["write_local_backup"] = json!(false);
    value
}

#[test]
fn backup_option_is_boolean_and_belongs_only_to_remote_save() {
    for option in [None, Some(true), Some(false)] {
        let mut value = input("7");
        if let Some(option) = option {
            value["write_local_backup"] = json!(option);
        }
        let parsed = crate::model::parse("remote.save", value).unwrap();
        assert_eq!(parsed.write_local_backup, option.unwrap_or(true));
    }
    for invalid in [Value::Null, json!("false"), json!(0), json!({})] {
        let mut value = input("7");
        value["write_local_backup"] = invalid;
        assert!(crate::model::parse("remote.save", value).is_err());
    }
    for operation in ["set", "remote.load", "get", "list", "import", "delete"] {
        assert!(crate::model::parse(operation, no_backup("7")).is_err());
    }
}

#[tokio::test]
async fn no_backup_save_holds_lock_and_leaves_local_bytes_and_revision() {
    let root = tempfile::tempdir().unwrap();
    let (path, original) = seed(root.path());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        assert!(
            request(&mut stream)
                .await
                .starts_with("POST /update_config/deviceInfo ")
        );
        entered.send(()).unwrap();
        released.await.unwrap();
        respond(&mut stream, 200, json!({"success":true})).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(150), listener.accept())
                .await
                .is_err()
        );
    });
    let pending = tokio::spawn(invoke(
        config(root.path(), &url),
        "remote.save",
        no_backup("7"),
    ));
    tokio::time::timeout(Duration::from_secs(3), started)
        .await
        .unwrap()
        .unwrap();
    let locked_root = root.path().to_owned();
    tokio::task::spawn_blocking(move || {
        let input = crate::model::parse("list", json!({"scope":"user","owner_id":"demo"})).unwrap();
        let checks = std::cell::Cell::new(0);
        let blocked = store::Lease::acquire(&locked_root, &input, &|| {
            checks.set(checks.get() + 1);
            if checks.get() >= 4 {
                Err("备份关闭仍须持锁".into())
            } else {
                Ok(())
            }
        });
        assert_eq!(blocked.err().as_deref(), Some("备份关闭仍须持锁"));
    })
    .await
    .unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    release.send(()).unwrap();
    let result = pending.await.unwrap();
    assert!(result["response"]["error"].is_null());
    assert_eq!(
        result["response"]["result"],
        json!({"format_version":1,"section":"deviceInfo","value":{"items":["new"]},"source":"remote","backup_updated":false,"revision":null,"remote_committed":true})
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    server.await.unwrap();
    let parsed = crate::model::parse("list", json!({"scope":"user","owner_id":"demo"})).unwrap();
    let lease = store::Lease::acquire(root.path(), &parsed, &|| Ok(())).unwrap();
    assert_eq!(lease.execute(parsed, &|| Ok(())).unwrap()["revision"], "7");
}

#[tokio::test]
async fn no_backup_save_rejects_stale_revision_before_any_post() {
    let root = tempfile::tempdir().unwrap();
    let (path, original) = seed(root.path());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let result = invoke(config(root.path(), &url), "remote.save", no_backup("6")).await;
    assert_eq!(result["response"]["error"], "配置修订冲突，未向远端写入");
    assert!(
        tokio::time::timeout(Duration::from_millis(150), listener.accept())
            .await
            .is_err()
    );
    assert_eq!(fs::read(path).unwrap(), original);
}

#[tokio::test]
async fn no_backup_cancel_after_post_keeps_local_bytes_without_retry() {
    let root = tempfile::tempdir().unwrap();
    let (path, original) = seed(root.path());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let (entered, cancel) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        request(&mut stream).await;
        entered.send(()).unwrap();
        let mut byte = [0_u8; 1];
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), stream.read(&mut byte))
                .await
                .unwrap()
                .unwrap(),
            0
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(150), listener.accept())
                .await
                .is_err()
        );
    });
    let result = invoke_controlled(
        config(root.path(), &url),
        "remote.save",
        no_backup("7"),
        Some(cancel),
    )
    .await;
    assert!(result["response"]["result"].is_null());
    assert!(
        result["response"]["error"]
            .as_str()
            .unwrap()
            .contains("取消")
    );
    assert_eq!(result["cleanup"], "complete");
    assert_eq!(fs::read(path).unwrap(), original);
    server.await.unwrap();
}

#[tokio::test]
async fn no_backup_first_save_leaves_no_document_and_explicit_true_writes_backup() {
    let root = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        for _round in 0..2 {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert!(
                request(&mut stream)
                    .await
                    .starts_with("POST /update_config/deviceInfo ")
            );
            respond(&mut stream, 200, json!({"success":true})).await;
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(150), listener.accept())
                .await
                .is_err()
        );
    });
    let skipped = invoke(config(root.path(), &url), "remote.save", no_backup("0")).await;
    assert!(skipped["response"]["error"].is_null());
    assert_eq!(skipped["response"]["result"]["remote_committed"], true);
    assert_eq!(skipped["response"]["result"]["backup_updated"], false);
    assert!(skipped["response"]["result"]["revision"].is_null());
    let path = root.path().join("users/demo/settings.json");
    assert!(!path.exists());
    let mut enabled = input("0");
    enabled["write_local_backup"] = json!(true);
    let saved = invoke(config(root.path(), &url), "remote.save", enabled).await;
    assert!(saved["response"]["error"].is_null());
    assert_eq!(saved["response"]["result"]["backup_updated"], true);
    assert_eq!(saved["response"]["result"]["revision"], "1");
    let persisted: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(persisted["revision"], "1");
    assert_eq!(
        persisted["sections"]["deviceInfo"],
        json!({"items":["new"]})
    );
    server.await.unwrap();
}
