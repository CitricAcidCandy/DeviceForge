mod fixtures;
use apk_plugin_sdk::{ArtifactOutput, cooperative::CleanupOutcome};
use deviceforge_plugin_runtime::{Execution, Output};
use serde_json::json;
use std::{path::PathBuf, time::Duration};

#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let directory = args.first().map(PathBuf::from);
    let mode = args.get(1).cloned().unwrap_or_default();
    if fixtures::handles(&mode) {
        return fixtures::serve(directory.as_deref(), &mode).await;
    }
    let wait_stdin_eof = mode == "sdk_stdin_eof";
    let eof_markers = directory.clone();
    deviceforge_plugin_runtime::serve_once(move |request, cancel| async move {
        if request.operation != "wait" {
            return Execution::complete(Err("示例只接受 wait".into()));
        }
        if std::env::var_os("APK_API_TOKEN").is_some() {
            return Execution::complete(Err("插件不应继承访问令牌".into()));
        }
        let millis = request
            .input
            .get("duration_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(100);
        if !(1..=3_600_000).contains(&millis) {
            return Execution::complete(Err("等待时间超出范围".into()));
        }
        if let Some(directory) = &directory
            && tokio::fs::write(directory.join("started"), std::process::id().to_string())
                .await
                .is_err()
        {
            return Execution::complete(Err("测试标记写入失败".into()));
        }
        // 模拟资源等待及异步清理；不代表已经连接真实设备。
        let cancelled = if mode == "ignore" {
            tokio::time::sleep(Duration::from_millis(millis)).await;
            false
        } else {
            tokio::select! {
                _ = cancel.cancelled() => true,
                _ = tokio::time::sleep(Duration::from_millis(millis)) => false,
            }
        };
        if cancelled
            && let Some(directory) = &directory
            && tokio::fs::write(directory.join("cancel_received"), "已收到取消令牌")
                .await
                .is_err()
        {
            return Execution {
                outcome: Err("取消标记写入失败".into()),
                cleanup: CleanupOutcome::Failed,
            };
        }
        if mode == "failed" {
            return Execution {
                outcome: Err("模拟外部资源清理失败".into()),
                cleanup: CleanupOutcome::Failed,
            };
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
        if let Some(directory) = &directory
            && tokio::fs::write(directory.join("cleaned"), "自有资源已清理")
                .await
                .is_err()
        {
            return Execution {
                outcome: Err("资源清理标记失败".into()),
                cleanup: CleanupOutcome::Failed,
            };
        }
        let value = json!({"waited_ms":millis,"synthetic_demo":true});
        if mode == "artifact" && !cancelled {
            let Some(output_directory) = request
                .artifacts
                .and_then(|context| context.output_directory)
            else {
                return Execution::complete(Err("缺少输出产物授权".into()));
            };
            let bytes = serde_json::to_vec(&value).expect("示例结果可序列化");
            if tokio::fs::write(PathBuf::from(output_directory).join("wait.json"), bytes)
                .await
                .is_err()
            {
                return Execution::complete(Err("示例产物写入失败".into()));
            }
            return Execution::complete(Ok(Output {
                value,
                artifacts: vec![ArtifactOutput {
                    filename: "wait.json".into(),
                }],
            }));
        }
        Execution::complete(Ok(value.into()))
    })
    .await?;
    if wait_stdin_eof {
        use tokio::io::AsyncReadExt;
        // 真实 SDK 响应已写出后仍等 EOF，确定性覆盖宿主取消分支的输入关闭。
        if let Some(directory) = &eof_markers {
            tokio::fs::write(directory.join("response_written"), "SDK 响应已写出")
                .await
                .map_err(|_| "响应标记写入失败")?;
        }
        let mut bytes = Vec::new();
        tokio::io::stdin()
            .take(4097)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "SDK 退出夹具读取 EOF 失败")?;
        if !bytes.is_empty() {
            return Err("SDK 响应后不接受额外输入".into());
        }
        if let Some(directory) = &eof_markers {
            tokio::fs::write(directory.join("stdin_eof"), "宿主响应后已关闭输入")
                .await
                .map_err(|_| "EOF 标记写入失败")?;
        }
    }
    Ok(())
}
