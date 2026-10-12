//! 模拟只在显式刷新时发布字节的输出，验证关闭不会替运行库交付终态帧。
use deviceforge_plugin_runtime::{Execution, serve_io, serve_io_with_context};
use serde_json::{Value, json};
use std::{
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};
use tokio::io::{AsyncWrite, AsyncWriteExt};

#[derive(Default)]
struct Published {
    bytes: Vec<u8>,
    shutdown: bool,
    pending_on_shutdown: usize,
}

struct BufferedOutput {
    published: Arc<Mutex<Published>>,
    pending: Vec<u8>,
    flush_count: usize,
    failed_flush: Option<usize>,
}

impl AsyncWrite for BufferedOutput {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.pending.extend_from_slice(bytes);
        Poll::Ready(Ok(bytes.len()))
    }

    fn poll_flush(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.flush_count += 1;
        if self.failed_flush == Some(self.flush_count) {
            return Poll::Ready(Err(io::Error::other("定点刷新失败")));
        }
        let bytes = std::mem::take(&mut self.pending);
        self.published.lock().unwrap().bytes.extend(bytes);
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        // 模拟当前 Tokio stdout 的实际行为：shutdown 不隐式完成缓冲写入。
        let mut published = self.published.lock().unwrap();
        published.shutdown = true;
        published.pending_on_shutdown = self.pending.len();
        Poll::Ready(Ok(()))
    }
}

async fn invoke(
    version: u32,
    fail_response_flush: bool,
) -> (Result<(), String>, Arc<Mutex<Published>>) {
    let published = Arc::new(Mutex::new(Published::default()));
    let writer = BufferedOutput {
        published: published.clone(),
        pending: Vec::new(),
        flush_count: 0,
        failed_flush: fail_response_flush.then_some(if version == 4 { 2 } else { 1 }),
    };
    let (mut host, plugin) = tokio::io::duplex(8192);
    let request = json!({"protocol_version":version,"request_id":"flush-proof",
        "operation":"flush.test","input":{}});
    let mut bytes = serde_json::to_vec(&request).unwrap();
    bytes.push(b'\n');
    if version == 4 {
        bytes.extend(
            serde_json::to_vec(&json!({"protocol_version":4,"request_id":"flush-proof",
            "command":"start","remaining_timeout_ns":10_000_000_000_u64}))
            .unwrap(),
        );
        bytes.push(b'\n');
    }
    host.write_all(&bytes).await.unwrap();
    // 宿主输入保持打开；响应交付不能依赖宿主先发 EOF。
    let result = tokio::time::timeout(Duration::from_secs(2), async {
        if version == 4 {
            serve_io_with_context(plugin, writer, |_, _| async {
                Execution::complete(Err("业务明确拒绝".into()))
            })
            .await
        } else {
            serve_io(plugin, writer, |_, _| async {
                Execution::complete(Err("业务明确拒绝".into()))
            })
            .await
        }
    })
    .await
    .expect("终态发送应及时返回");
    drop(host);
    (result, published)
}

#[tokio::test]
async fn final_response_is_published_before_shutdown_for_both_protocols() {
    for version in [3, 4] {
        let (result, published) = invoke(version, false).await;
        result.expect("响应交付成功");
        let published = published.lock().unwrap();
        assert!(published.shutdown);
        assert_eq!(published.pending_on_shutdown, 0, "关闭前不得遗留末帧字节");
        assert_eq!(published.bytes.last(), Some(&b'\n'));
        let frames: Vec<Value> = published
            .bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        assert_eq!(frames.len(), if version == 4 { 2 } else { 1 });
        let response = frames.last().unwrap();
        assert_eq!(response["response"]["protocol_version"], version);
        assert_eq!(response["response"]["request_id"], "flush-proof");
        assert_eq!(response["response"]["error"], "业务明确拒绝");
        assert_eq!(response["cleanup"], "complete");
    }
}

#[tokio::test]
async fn final_response_flush_failure_is_returned_without_successful_shutdown() {
    for version in [3, 4] {
        let (result, published) = invoke(version, true).await;
        assert_eq!(result.unwrap_err(), "响应刷新失败");
        assert!(
            !published.lock().unwrap().shutdown,
            "刷新失败不能继续记为正常关闭"
        );
    }
}
