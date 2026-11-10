use super::*;
use apk_domain::{Error, plugin_guides::MAX_GUIDE_BYTES};
use std::{fs, path::Path, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

fn directory() -> tempfile::TempDir {
    let artifacts = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../artifacts/guide-io-tests");
    fs::create_dir_all(&artifacts).unwrap();
    tempfile::Builder::new()
        .prefix("case-")
        .tempdir_in(artifacts)
        .unwrap()
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(3)
}

fn store(directory: &Path, source: &str) -> HttpGuideStore {
    HttpGuideStore::new(directory.to_path_buf(), source).unwrap()
}

async fn server(reply: Vec<u8>) -> (String, JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(3), async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0u8; 8192];
            let length = stream.read(&mut request).await.unwrap();
            // 超限响应可能在接收完请求头之后被客户端立即关闭。
            let _ = stream.write_all(&reply).await;
            String::from_utf8(request[..length].to_vec()).unwrap()
        })
        .await
        .unwrap()
    });
    (format!("http://{address}/guide.json"), task)
}

fn response(status: &str, body: &[u8]) -> Vec<u8> {
    let mut bytes = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

#[test]
fn source_rejects_credentials_fragments_and_non_local_http() {
    let directory = directory();
    for source in [
        "http://example.com/guide.json",
        "https://user:secret@example.com/guide.json",
        "https://example.com/guide.json#token",
        "file:///G:/guide.json",
        "not a url",
    ] {
        assert!(matches!(
            HttpGuideStore::new(directory.path().to_path_buf(), source),
            Err(Error::Invalid(_))
        ));
    }
    for source in [
        "https://example.com/guide.json",
        "http://127.0.0.1/guide.json",
        "http://[::1]/guide.json",
    ] {
        assert!(HttpGuideStore::new(directory.path().to_path_buf(), source).is_ok());
    }
}

#[tokio::test]
async fn successful_download_has_no_business_credentials() {
    let directory = directory();
    let (source, task) = server(response("200 OK", b"public-guide")).await;
    let bytes = store(directory.path(), &source)
        .download(deadline(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(bytes, b"public-guide");
    let request = task.await.unwrap().to_ascii_lowercase();
    assert!(!request.contains("authorization:"));
    assert!(!request.contains("cookie:"));
    assert!(!directory.path().join("current.json").exists());
}

#[tokio::test]
async fn http_failure_and_both_download_size_limits_preserve_current_bytes() {
    let directory = directory();
    fs::write(directory.path().join("current.json"), b"previous").unwrap();
    let cases = [
        (response("503 Unavailable", b"unavailable"), false),
        (
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_GUIDE_BYTES + 1
            )
            .into_bytes(),
            true,
        ),
        (
            [
                b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".as_slice(),
                &vec![b'x'; MAX_GUIDE_BYTES + 1],
            ]
            .concat(),
            true,
        ),
    ];
    for (reply, too_large) in cases {
        let (source, task) = server(reply).await;
        let result = store(directory.path(), &source)
            .download(deadline(), CancellationToken::new())
            .await;
        assert!(if too_large {
            matches!(result, Err(Error::TooLarge))
        } else {
            matches!(result, Err(Error::Dependency(_)))
        });
        task.await.unwrap();
        assert_eq!(
            fs::read(directory.path().join("current.json")).unwrap(),
            b"previous"
        );
    }
}

#[tokio::test]
async fn cache_save_replaces_atomically_and_load_is_bounded() {
    let directory = directory();
    let store = store(directory.path(), "https://example.com/guide.json");
    assert!(
        store
            .load(deadline(), CancellationToken::new())
            .await
            .unwrap()
            .is_none()
    );
    store
        .save(b"first".to_vec(), deadline(), CancellationToken::new())
        .await
        .unwrap();
    store
        .save(b"second".to_vec(), deadline(), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        store
            .load(deadline(), CancellationToken::new())
            .await
            .unwrap()
            .unwrap(),
        b"second"
    );
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    assert!(matches!(
        store
            .save(
                vec![0; MAX_GUIDE_BYTES + 1],
                deadline(),
                CancellationToken::new()
            )
            .await,
        Err(Error::TooLarge)
    ));
    assert_eq!(
        fs::read(directory.path().join("current.json")).unwrap(),
        b"second"
    );
    fs::write(
        directory.path().join("current.json"),
        vec![0; MAX_GUIDE_BYTES + 1],
    )
    .unwrap();
    assert!(matches!(
        store.load(deadline(), CancellationToken::new()).await,
        Err(Error::TooLarge)
    ));
}

#[tokio::test]
async fn cancelled_and_expired_waiters_do_not_publish_or_start_network() {
    let directory = directory();
    let store = store(directory.path(), "http://127.0.0.1:1/guide.json");
    fs::write(directory.path().join("current.json"), b"previous").unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(matches!(
        store.download(deadline(), cancel.clone()).await,
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        store.load(deadline(), cancel.clone()).await,
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        store.save(b"cancelled".to_vec(), deadline(), cancel).await,
        Err(Error::Cancelled)
    ));
    let held = store.writers.acquire().await.unwrap();
    let until = Instant::now() + Duration::from_millis(20);
    assert!(matches!(
        store
            .save(b"expired".to_vec(), until, CancellationToken::new())
            .await,
        Err(Error::Timeout)
    ));
    drop(held);
    tokio::task::yield_now().await;
    assert_eq!(
        fs::read(directory.path().join("current.json")).unwrap(),
        b"previous"
    );
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[tokio::test]
async fn stalled_download_obeys_total_deadline_and_cancellation() {
    let directory = directory();
    for cancel_in_flight in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let source = format!("http://{}/guide.json", listener.local_addr().unwrap());
        let stop = CancellationToken::new();
        let finish = stop.clone();
        let (connected, accepted) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            tokio::time::timeout(Duration::from_secs(3), async move {
                let (_stream, _) = listener.accept().await.unwrap();
                let _ = connected.send(());
                finish.cancelled().await;
            })
            .await
            .unwrap();
        });
        let cancel = CancellationToken::new();
        let store = store(directory.path(), &source);
        let until = Instant::now() + Duration::from_millis(150);
        let (result, ()) = tokio::join!(store.download(until, cancel.clone()), async {
            accepted.await.unwrap();
            if cancel_in_flight {
                cancel.cancel();
            }
        },);
        stop.cancel();
        task.await.unwrap();
        assert!(if cancel_in_flight {
            matches!(result, Err(Error::Cancelled))
        } else {
            matches!(result, Err(Error::Timeout))
        });
    }
}

#[tokio::test]
async fn redirect_rejects_non_local_http_and_stops_after_three_hops() {
    let directory = directory();
    let (source, task) = server(b"HTTP/1.1 302 Found\r\nLocation: http://example.com/guide.json\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()).await;
    assert!(matches!(
        store(directory.path(), &source)
            .download(deadline(), CancellationToken::new())
            .await,
        Err(Error::Dependency(_))
    ));
    task.await.unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let source = format!("http://{}/loop", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(3), async move {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut input = [0u8; 4096];
                stream.read(&mut input).await.unwrap();
                stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: /loop\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            }
        }).await.unwrap();
    });
    assert!(matches!(
        store(directory.path(), &source)
            .download(deadline(), CancellationToken::new())
            .await,
        Err(Error::Dependency(_))
    ));
    task.await.unwrap();
}

#[cfg(windows)]
#[tokio::test]
async fn failed_atomic_replacement_keeps_old_bytes_and_cleans_own_stage() {
    use std::os::windows::fs::OpenOptionsExt;
    let directory = directory();
    let path = directory.path().join("current.json");
    fs::write(&path, b"previous").unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&path)
        .unwrap();
    let result = store(directory.path(), "https://example.com/guide.json")
        .save(b"new".to_vec(), deadline(), CancellationToken::new())
        .await;
    assert!(matches!(result, Err(Error::Storage(_))));
    assert_eq!(fs::read(&path).unwrap(), b"previous");
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    drop(held);
}

#[test]
fn expired_or_dropped_blocking_work_cannot_publish_when_it_later_starts() {
    let directory = directory();
    let path = directory.path().join("current.json");
    fs::write(&path, b"previous").unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        for drop_before_deadline in [false, true] {
            let (started, ready) = tokio::sync::oneshot::channel();
            let (release, waiting) = std::sync::mpsc::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                let _ = started.send(());
                waiting.recv().unwrap();
            });
            ready.await.unwrap();
            let store = store(directory.path(), "https://example.com/guide.json");
            if drop_before_deadline {
                let mut saving =
                    Box::pin(store.save(b"dropped".to_vec(), deadline(), CancellationToken::new()));
                assert!(
                    tokio::time::timeout(Duration::from_millis(20), &mut saving)
                        .await
                        .is_err()
                );
                drop(saving);
            } else {
                let result = store
                    .save(
                        b"late".to_vec(),
                        Instant::now() + Duration::from_millis(20),
                        CancellationToken::new(),
                    )
                    .await;
                assert!(matches!(result, Err(Error::Timeout)));
            }
            release.send(()).unwrap();
            blocker.await.unwrap();
            // 持有同一写许可的迟到工作收尾后，独立读取才能获得结果。
            let _writer = store.writers.acquire().await.unwrap();
            assert_eq!(fs::read(&path).unwrap(), b"previous");
            assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        }
    });
}
