use super::{fixture, request};
use crate::*;
use deviceforge_plugin_runtime::{Execution, InvocationContext};
use serde_json::{Value, json};
use std::{future::Future, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

pub(crate) struct Client {
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
    runtime: tokio::task::JoinHandle<std::result::Result<(), String>>,
}

impl Client {
    pub(crate) async fn start<Handler, HandlerFuture>(
        request: apk_plugin_sdk::Request,
        budget_ns: u64,
        delay: Duration,
        handler: Handler,
    ) -> Self
    where
        Handler:
            FnOnce(apk_plugin_sdk::Request, InvocationContext) -> HandlerFuture + Send + 'static,
        HandlerFuture: Future<Output = Execution> + Send + 'static,
    {
        let (host, plugin) = tokio::io::duplex(65_536);
        let (reader, writer) = tokio::io::split(host);
        let (plugin_reader, plugin_writer) = tokio::io::split(plugin);
        let runtime = tokio::spawn(deviceforge_plugin_runtime::serve_io_with_context(
            plugin_reader,
            plugin_writer,
            handler,
        ));
        let mut client = Self {
            reader: BufReader::new(reader),
            writer,
            runtime,
        };
        client.send(serde_json::to_value(request).unwrap()).await;
        let ready = client.line().await;
        assert_eq!(ready["command"], "ready");
        tokio::time::sleep(delay).await;
        client.send(json!({"protocol_version":4,"request_id":"dex-case","command":"start","remaining_timeout_ns":budget_ns})).await;
        client
    }

    pub(crate) async fn send(&mut self, value: Value) {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        self.writer.write_all(&bytes).await.unwrap();
    }

    async fn line(&mut self) -> Value {
        let mut line = String::new();
        assert!(
            tokio::time::timeout(Duration::from_secs(10), self.reader.read_line(&mut line))
                .await
                .unwrap()
                .unwrap()
                > 0
        );
        serde_json::from_str(&line).unwrap()
    }

    pub(crate) async fn result(mut self) -> Value {
        let response = self.line().await;
        let envelope: apk_plugin_sdk::cooperative::CooperativeResponse =
            serde_json::from_value(response.clone()).unwrap();
        assert_eq!(envelope.response.protocol_version, 4);
        assert_eq!(envelope.response.request_id, "dex-case");
        self.runtime.await.unwrap().unwrap();
        response
    }
}

#[tokio::test]
async fn real_authorized_dex_file_returns_counts_over_public_context_frames() {
    let sample = fixture::sample(&["com/example/sdk/Entry"], &["com/reference/External"]);
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("classes.dex");
    tokio::fs::write(&path, &sample.bytes).await.unwrap();
    let request = request(&sample.bytes, path.to_str().unwrap().into(), "inspect");
    let response = Client::start(request, 10_000_000_000, Duration::ZERO, execute)
        .await
        .result()
        .await;
    assert_eq!(response["cleanup"], "complete");
    assert_eq!(
        response["response"]["result"]["counts"]["defined_classes"],
        1
    );
    assert_eq!(response["response"]["result"]["counts"]["types"], 2);
    assert_eq!(
        response["response"]["result"]["integrity"],
        json!({"artifact_sha256":true,"dex_sha1":true,"dex_adler32":true})
    );
    assert_eq!(tokio::fs::read(&path).await.unwrap(), sample.bytes);
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[tokio::test]
async fn scan_frames_ignore_external_reference_and_preserve_inner_class_evidence() {
    let sample = fixture::sample(
        &["com/example/sdk/Entry$Inner"],
        &["com/reference/sdk/Entry"],
    );
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("classes.dex");
    tokio::fs::write(&path, &sample.bytes).await.unwrap();
    let mut request = request(&sample.bytes, path.to_str().unwrap().into(), "scan_sdks");
    request.input["rules"] = json!([
        {"name":"defined","package_path":"com.example.sdk","class_name":"Entry$Inner"},
        {"name":"external","package_path":"com.reference.sdk"},
    ]);
    let response = Client::start(request, 10_000_000_000, Duration::ZERO, execute)
        .await
        .result()
        .await;
    assert_eq!(response["cleanup"], "complete");
    let findings = &response["response"]["result"]["findings"];
    assert_eq!(findings[0]["class_found"], true);
    assert_eq!(
        findings[0]["evidence"],
        json!(["com/example/sdk/Entry$Inner"])
    );
    assert_eq!(findings[1]["package_found"], false);
    assert_eq!(findings[1]["class_found"], Value::Null);
}

#[tokio::test]
async fn authorized_hash_mismatch_fails_without_leaking_path_or_modifying_source() {
    let sample = fixture::sample(&["com/example/Entry"], &[]);
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("private-name.dex");
    tokio::fs::write(&path, &sample.bytes).await.unwrap();
    let mut request = request(&sample.bytes, path.to_str().unwrap().into(), "inspect");
    request.artifacts.as_mut().unwrap().inputs[0].sha256 = "0".repeat(64);
    let response = Client::start(request, 10_000_000_000, Duration::ZERO, execute)
        .await
        .result()
        .await;
    assert_eq!(response["cleanup"], "complete");
    assert!(
        response["response"]["error"]
            .as_str()
            .unwrap()
            .contains("SHA256")
    );
    assert!(!response.to_string().contains("private-name"));
    assert_eq!(tokio::fs::read(&path).await.unwrap(), sample.bytes);
}
