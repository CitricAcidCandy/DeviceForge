use apk_plugin_sdk::cooperative::CleanupOutcome;
use deviceforge_plugin_runtime::Execution;
use serde_json::json;
use std::{path::PathBuf, time::Duration};

#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let directory = args.first().map(PathBuf::from);
    let mode = args.get(1).cloned().unwrap_or_default();
    deviceforge_plugin_runtime::serve_once(move |request, cancel| async move {
        if request.operation != "wait" { return Execution::complete(Err("示例只接受 wait".into())); }
        if std::env::var_os("APK_API_TOKEN").is_some() { return Execution::complete(Err("插件不应继承访问令牌".into())); }
        let millis = request.input.get("duration_ms").and_then(|v| v.as_u64()).unwrap_or(100);
        if !(1..=3_600_000).contains(&millis) { return Execution::complete(Err("等待时间超出范围".into())); }
        if let Some(directory) = &directory {
            if tokio::fs::write(directory.join("started"), std::process::id().to_string()).await.is_err() {
                return Execution::complete(Err("测试标记写入失败".into()));
            }
        }
        // 模拟资源等待及异步清理；不代表已经连接真实设备。
        if mode == "ignore" { tokio::time::sleep(Duration::from_millis(millis)).await; }
        else { tokio::select! { _ = cancel.cancelled() => {}, _ = tokio::time::sleep(Duration::from_millis(millis)) => {} } }
        if mode == "failed" { return Execution { outcome: Err("模拟外部资源清理失败".into()), cleanup: CleanupOutcome::Failed }; }
        tokio::time::sleep(Duration::from_millis(40)).await;
        if let Some(directory) = &directory {
            if tokio::fs::write(directory.join("cleaned"), "自有资源已清理").await.is_err() {
                return Execution { outcome: Err("资源清理标记失败".into()), cleanup: CleanupOutcome::Failed };
            }
        }
        Execution::complete(Ok(json!({"waited_ms":millis,"synthetic_demo":true}).into()))
    }).await
}
