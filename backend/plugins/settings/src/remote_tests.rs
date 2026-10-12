//! 通过公开协议4获得真实执行上下文，验证远端保存与本地CAS锁的共同所有权。
use super::*;
use deviceforge_plugin_runtime::{Execution, Output, serve_io_with_context};
use std::time::Duration;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};

pub(super) fn config(root: &std::path::Path, url: &str) -> Config {
    serde_json::from_value(json!({"format_version":1,"storage_root":root,
        "remote":{"base_url":url,"headers":{}}}))
    .unwrap()
}

pub(super) fn input(revision: &str) -> Value {
    json!({"scope":"user","owner_id":"demo","section":"deviceInfo",
        "expected_revision":revision,"value":{"items":["new"]}})
}

pub(super) async fn invoke(config: Config, operation: &str, input: Value) -> Value {
    invoke_controlled(config, operation, input, None).await
}

pub(super) async fn invoke_controlled(
    config: Config,
    operation: &str,
    input: Value,
    cancel: Option<tokio::sync::oneshot::Receiver<()>>,
) -> Value {
    let (host, plugin) = tokio::io::duplex(16 * 1024);
    let (plugin_read, plugin_write) = tokio::io::split(plugin);
    let task = tokio::spawn(serve_io_with_context(
        plugin_read,
        plugin_write,
        move |request, context| async move {
            let result = match crate::model::parse(&request.operation, request.input) {
                Ok(input) => execute(config, input, &context).await,
                Err(error) => Err(error),
            };
            Execution::complete(result.map(Output::from))
        },
    ));
    let (host_read, mut host_write) = tokio::io::split(host);
    let mut reader = BufReader::new(host_read);
    host_write.write_all(format!("{}\n", json!({"protocol_version":4,"request_id":"remote-test","operation":operation,"input":input})).as_bytes()).await.unwrap();
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(10), reader.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&line).unwrap()["command"],
        "ready"
    );
    host_write.write_all(b"{\"protocol_version\":4,\"request_id\":\"remote-test\",\"command\":\"start\",\"remaining_timeout_ns\":5000000000}\n").await.unwrap();
    if let Some(cancel) = cancel {
        tokio::time::timeout(Duration::from_secs(3), cancel)
            .await
            .unwrap()
            .unwrap();
        host_write.write_all(b"{\"protocol_version\":4,\"request_id\":\"remote-test\",\"command\":\"cancel\",\"reason\":\"cancelled\"}\n").await.unwrap();
    }
    line.clear();
    tokio::time::timeout(Duration::from_secs(10), reader.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    drop(host_write);
    task.await.unwrap().unwrap();
    serde_json::from_str(&line).unwrap()
}

pub(super) async fn respond(stream: &mut TcpStream, status: u16, value: Value) {
    let bytes = serde_json::to_vec(&value).unwrap();
    stream
        .write_all(
            format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    stream.write_all(&bytes).await.unwrap();
    stream.shutdown().await.unwrap();
}

pub(super) async fn request(stream: &mut TcpStream) -> String {
    let mut reader = BufReader::new(stream);
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        assert!(reader.read_line(&mut line).await.unwrap() > 0);
        if line == "\r\n" {
            break;
        }
        headers.push_str(&line);
    }
    let length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await.unwrap();
    if length > 0 {
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"items":["new"]})
        );
    }
    headers
}

#[tokio::test]
async fn save_updates_backup_and_failed_load_returns_the_same_backup() {
    let root = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        assert!(
            request(&mut stream)
                .await
                .starts_with("POST /update_config/deviceInfo ")
        );
        respond(&mut stream, 200, json!({"success":true})).await;
        let (mut stream, _) = listener.accept().await.unwrap();
        assert!(
            request(&mut stream)
                .await
                .starts_with("GET /get_config/deviceInfo ")
        );
        respond(&mut stream, 503, json!({"success":false})).await;
    });
    let saved = invoke(config(root.path(), &url), "remote.save", input("0")).await;
    assert!(saved["response"]["error"].is_null());
    assert_eq!(saved["response"]["result"]["revision"], "1");
    assert_eq!(saved["response"]["result"]["remote_committed"], true);
    let mut load = input("1");
    load.as_object_mut().unwrap().remove("value");
    let cached = invoke(config(root.path(), &url), "remote.load", load).await;
    server.await.unwrap();
    assert!(cached["response"]["error"].is_null());
    assert_eq!(cached["response"]["result"]["source"], "local");
    assert_eq!(cached["response"]["result"]["remote_committed"], false);
    assert_eq!(
        cached["response"]["result"]["value"],
        json!({"items":["new"]})
    );
}

#[tokio::test]
async fn concurrent_saves_with_one_revision_send_only_the_winning_post() {
    let root = tempfile::tempdir().unwrap();
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
    });
    let first = tokio::spawn(invoke(config(root.path(), &url), "remote.save", input("0")));
    tokio::time::timeout(Duration::from_secs(3), started)
        .await
        .unwrap()
        .unwrap();
    let locked_root = root.path().to_owned();
    let waiting = tokio::task::spawn_blocking(move || {
        let input = crate::model::parse("list", json!({"scope":"user","owner_id":"demo"})).unwrap();
        let checks = std::cell::Cell::new(0);
        store::Lease::acquire(&locked_root, &input, &|| {
            checks.set(checks.get() + 1);
            if checks.get() >= 4 {
                Err("锁等待取消".into())
            } else {
                Ok(())
            }
        })
        .err()
    })
    .await
    .unwrap();
    assert_eq!(waiting.as_deref(), Some("锁等待取消"));
    let second = tokio::spawn(invoke(config(root.path(), &url), "remote.save", input("0")));
    release.send(()).unwrap();
    let first = first.await.unwrap();
    let second = second.await.unwrap();
    server.await.unwrap();
    assert!(first["response"]["error"].is_null());
    assert_eq!(first["response"]["result"]["revision"], "1");
    assert!(
        second["response"]["error"]
            .as_str()
            .unwrap()
            .contains("配置修订冲突")
    );
    let document: Value = serde_json::from_slice(
        &std::fs::read(root.path().join("users/demo/settings.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(document["revision"], "1");
}

#[tokio::test]
async fn successful_remote_load_with_stale_revision_does_not_overwrite_backup() {
    let root = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        request(&mut stream).await;
        respond(&mut stream, 200, json!({"success":true})).await;
        let (mut stream, _) = listener.accept().await.unwrap();
        request(&mut stream).await;
        respond(
            &mut stream,
            200,
            json!({"success":true,"data":{"items":["remote"]}}),
        )
        .await;
    });
    let saved = invoke(config(root.path(), &url), "remote.save", input("0")).await;
    assert!(saved["response"]["error"].is_null());
    let path = root.path().join("users/demo/settings.json");
    let original = std::fs::read(&path).unwrap();
    let mut load = input("0");
    load.as_object_mut().unwrap().remove("value");
    let result = invoke(config(root.path(), &url), "remote.load", load).await;
    server.await.unwrap();
    assert_eq!(result["response"]["result"]["source"], "remote");
    assert_eq!(result["response"]["result"]["backup_updated"], false);
    assert!(result["response"]["result"]["revision"].is_null());
    assert_eq!(
        result["response"]["result"]["value"],
        json!({"items":["remote"]})
    );
    assert_eq!(std::fs::read(path).unwrap(), original);
}

#[tokio::test]
async fn cancelled_load_does_not_return_cached_success_or_change_backup() {
    let root = tempfile::tempdir().unwrap();
    let owner = root.path().join("users/demo");
    std::fs::create_dir_all(&owner).unwrap();
    let original =
        br#"{"format_version":1,"revision":"1","sections":{"deviceInfo":{"items":["old"]}}}"#;
    let path = owner.join("settings.json");
    std::fs::write(&path, original).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let (entered, cancel) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        request(&mut stream).await;
        entered.send(()).unwrap();
        released.await.unwrap();
    });
    let mut load = input("1");
    load.as_object_mut().unwrap().remove("value");
    let result =
        invoke_controlled(config(root.path(), &url), "remote.load", load, Some(cancel)).await;
    release.send(()).unwrap();
    server.await.unwrap();
    assert!(result["response"]["result"].is_null());
    assert!(
        result["response"]["error"]
            .as_str()
            .unwrap()
            .contains("取消")
    );
    assert_eq!(result["cleanup"], "complete");
    assert_eq!(std::fs::read(path).unwrap(), original);
}
