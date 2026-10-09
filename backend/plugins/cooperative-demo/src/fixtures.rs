//! 管理员 argv 选择的真实进程故障夹具，不扩展公开业务输入。
use apk_plugin_sdk::{Request, cooperative::RESPONSE_LIMIT};
use serde_json::json;
use std::{path::Path, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub fn handles(mode: &str) -> bool {
    matches!(
        mode,
        "eof"
            | "nonzero"
            | "wrong_id"
            | "wrong_version"
            | "wrong_response"
            | "legacy_response"
            | "nonzero_response"
            | "partial_response"
            | "oversized_stdout"
            | "oversized_stderr"
    )
}

pub async fn serve(directory: Option<&Path>, mode: &str) -> Result<(), String> {
    let mut line = String::new();
    let mut reader = BufReader::new(tokio::io::stdin());
    reader
        .read_line(&mut line)
        .await
        .map_err(|_| "夹具请求读取失败")?;
    let request: Request = serde_json::from_str(&line).map_err(|_| "夹具请求无效")?;
    if let Some(directory) = directory {
        tokio::fs::write(directory.join("started"), std::process::id().to_string())
            .await
            .map_err(|_| "夹具启动标记失败")?;
    }
    if mode == "eof" {
        return Ok(());
    }
    if mode == "nonzero" {
        return Err("模拟非零退出".into());
    }
    if mode == "partial_response" {
        let bytes = serde_json::to_vec(&json!({"response":{"protocol_version":3,"request_id":request.request_id,"result":null},"cleanup":"complete"})).map_err(|_| "分段响应序列化失败")?;
        let middle = bytes.len() / 2;
        let mut stdout = tokio::io::stdout();
        stdout
            .write_all(&bytes[..middle])
            .await
            .map_err(|_| "分段响应写入失败")?;
        stdout.flush().await.map_err(|_| "分段响应刷新失败")?;
        if let Some(directory) = directory {
            tokio::fs::write(directory.join("partial_written"), "响应前半段已写入")
                .await
                .map_err(|_| "分段响应标记失败")?;
        }
        line.clear();
        reader
            .read_line(&mut line)
            .await
            .map_err(|_| "分段夹具取消读取失败")?;
        let control: apk_plugin_sdk::cooperative::ControlFrame =
            serde_json::from_str(&line).map_err(|_| "分段夹具控制帧无效")?;
        if control.request_id != request.request_id || control.protocol_version != 3 {
            return Err("分段夹具控制关联失败".into());
        }
        if let Some(directory) = directory {
            tokio::fs::write(directory.join("cancel_received"), "分段夹具收到取消")
                .await
                .map_err(|_| "分段夹具取消标记失败")?;
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
        if let Some(directory) = directory {
            tokio::fs::write(directory.join("cleaned"), "分段夹具清理完成")
                .await
                .map_err(|_| "分段夹具清理标记失败")?;
        }
        stdout
            .write_all(&bytes[middle..])
            .await
            .map_err(|_| "分段响应尾部失败")?;
        stdout
            .write_all(b"\n")
            .await
            .map_err(|_| "分段响应结束失败")?;
        return Ok(());
    }
    if matches!(mode, "oversized_stdout" | "oversized_stderr") {
        let bytes = vec![b'x'; RESPONSE_LIMIT + 1];
        if mode == "oversized_stdout" {
            tokio::io::stdout()
                .write_all(&bytes)
                .await
                .map_err(|_| "夹具标准输出失败")?;
        } else {
            tokio::io::stderr()
                .write_all(&bytes)
                .await
                .map_err(|_| "夹具标准错误失败")?;
        }
        // 保持进程存活，证明宿主因输出超限终止了真实子进程。
        tokio::time::sleep(Duration::from_secs(60)).await;
        return Ok(());
    }
    let mut response = json!({"protocol_version":3,"request_id":request.request_id,"result":null});
    match mode {
        "wrong_id" => response["request_id"] = json!("wrong"),
        "wrong_version" => response["protocol_version"] = json!(2),
        "wrong_response" => response["error"] = json!("不能同时携带成功与错误"),
        _ => {}
    }
    let reply = if mode == "legacy_response" {
        response
    } else {
        json!({"response":response,"cleanup":"complete"})
    };
    let mut bytes = serde_json::to_vec(&reply).map_err(|_| "夹具响应序列化失败")?;
    bytes.push(b'\n');
    tokio::io::stdout()
        .write_all(&bytes)
        .await
        .map_err(|_| "夹具响应写入失败")?;
    if mode == "nonzero_response" {
        return Err("模拟声明清理后非零退出".into());
    }
    Ok(())
}
