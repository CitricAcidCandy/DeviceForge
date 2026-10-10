//! 经公开协议取得执行上下文，检查真实worker与目录租约收口。
mod worker;
use super::*;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream};

struct ContextOwner {
    context: InvocationContext,
    client: BufReader<DuplexStream>,
    release: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<std::result::Result<(), String>>,
}

impl ContextOwner {
    async fn start() -> Self {
        let (client, server) = tokio::io::duplex(8192);
        let (reader, writer) = tokio::io::split(server);
        let (send, context) = tokio::sync::oneshot::channel();
        let (release, waiting) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(deviceforge_plugin_runtime::serve_io_with_context(
            reader,
            writer,
            move |_, context| async move {
                send.send(context).unwrap();
                waiting.await.unwrap();
                Execution::complete(Ok(json!({}).into()))
            },
        ));
        let mut client = BufReader::new(client);
        let mut request = serde_json::to_vec(&json!({"protocol_version":4,
            "request_id":"session-test","operation":"manifest","input":{}}))
        .unwrap();
        request.push(b'\n');
        client.get_mut().write_all(&request).await.unwrap();
        let mut ready = String::new();
        client.read_line(&mut ready).await.unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&ready).unwrap()["command"],
            "ready"
        );
        let mut start = serde_json::to_vec(&json!({"protocol_version":4,
            "request_id":"session-test","command":"start","remaining_timeout_ns":60_000_000_000u64})).unwrap();
        start.push(b'\n');
        client.get_mut().write_all(&start).await.unwrap();
        Self {
            context: context.await.unwrap(),
            client,
            release,
            task,
        }
    }

    async fn close(mut self) {
        self.release.send(()).unwrap();
        let mut response = Vec::new();
        self.client.read_to_end(&mut response).await.unwrap();
        self.task.await.unwrap().unwrap();
    }

    fn session(&self) -> Session {
        let directory = tempfile::Builder::new()
            .prefix("deviceforge-android-packages-")
            .tempdir()
            .unwrap();
        let root = directory.keep();
        Session {
            input: Input {
                artifact_id: "input".into(),
                filename: "input.apk".into(),
                size: 0,
                sha256: String::new(),
                path: root.join("source.apk"),
            },
            output: root.clone(),
            config: Config::default(),
            context: self.context.clone(),
            lease: Arc::new(Lease { path: root.clone() }),
            root,
            slots: Arc::new(Semaphore::new(1)),
            unresolved: Arc::default(),
            cleanup_until: Mutex::new(None),
        }
    }
}

#[tokio::test]
async fn missing_owned_directory_never_reports_complete() {
    let owner = ContextOwner::start().await;
    let session = owner.session();
    files::remove_owned(&session.root).unwrap();
    let execution = session.finish(Ok(json!({}).into())).await;
    assert_eq!(execution.cleanup, CleanupOutcome::Failed);
    assert_eq!(execution.outcome.err().unwrap(), "插件资源清理未确认");
    owner.close().await;
}
