//! 真实管道验证快速错误末帧先于输入 EOF 到达，并等待本测试子进程零退出。
//! 自启动测试程序只运行专用子测试；有限忽略 libtest 非 JSON 行，不启动宿主服务。

use apk_plugin_sdk::{Request, cooperative::CooperativeResponse};
use deviceforge_plugin_runtime::{Execution, serve_once, serve_once_with_context};
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, Command},
    time::{Instant, timeout_at},
};

const CHILD_ENV: &str = "DEVICEFORGE_CONTEXT_STDIO_CHILD";
const CHILD_TEST: &str = "context_stdio_child";
const ROUND_LIMIT: Duration = Duration::from_secs(15);
const CLEANUP_LIMIT: Duration = Duration::from_secs(2);
const SUITE_LIMIT: Duration = Duration::from_secs(60);
const REPEATS: usize = 8;
const FRAME_LIMIT: usize = 4096;
const DIAGNOSTIC_LIMIT: usize = 8192;
const NON_JSON_LINES: usize = 16;
const IMMEDIATE: &str = "fixture.reject.immediate";
const BLOCKING: &str = "fixture.reject.blocking";

fn rejection(pid: u32) -> String {
    format!("合成快速拒绝：上一轮未确认完成（PID={pid}）")
}

async fn reject(request: Request) -> Execution {
    let error = rejection(std::process::id());
    let error = match request.operation.as_str() {
        IMMEDIATE => error,
        // 对应 AI 线程 begin 在阻塞池返回业务错误后立刻发送末帧的路径。
        BLOCKING => match tokio::task::spawn_blocking(move || error).await {
            Ok(error) => error,
            Err(_) => "合成拒绝工作异常".into(),
        },
        _ => "未知合成拒绝操作".into(),
    };
    Execution::complete(Err(error))
}

#[test]
fn context_stdio_child() {
    let Ok(protocol) = std::env::var(CHILD_ENV) else {
        return;
    };
    assert!(matches!(protocol.as_str(), "3" | "4"), "子测试协议有效");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        // 一个线程允许控制读取保持阻塞，另一个执行文件工作或响应写入。
        .max_blocking_threads(2)
        .enable_all()
        .build()
        .expect("创建专用 stdio 运行时");
    runtime
        .block_on(async {
            if protocol == "4" {
                serve_once_with_context(|request, context| async move {
                    context.check().expect("快速拒绝前上下文仍有效");
                    reject(request).await
                })
                .await
            } else {
                serve_once(|request, cancel| async move {
                    assert!(!cancel.is_cancelled(), "错误末帧前输入仍打开");
                    reject(request).await
                })
                .await
            }
        })
        .expect("公开 stdio 入口成功交付错误末帧");
    // 必须真实销毁运行时；不能用 process::exit 绕过标准输入阻塞线程退出。
    drop(runtime);
}

async fn send(stdin: &mut ChildStdin, frame: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(frame).map_err(|_| "合成帧编码失败".to_owned())?;
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .await
        .map_err(|_| "子进程输入写入失败".to_owned())
}

async fn frame(reader: &mut BufReader<impl AsyncRead + Unpin>) -> Result<Value, String> {
    for _ in 0..NON_JSON_LINES {
        let mut line = Vec::new();
        (&mut *reader)
            .take(FRAME_LIMIT as u64 + 1)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|_| "子进程输出读取失败".to_owned())?;
        if line.is_empty() {
            return Err("完整协议帧前子进程输出已结束".into());
        }
        if line.len() > FRAME_LIMIT || line.last() != Some(&b'\n') {
            return Err("协议帧超限或缺少末尾换行".into());
        }
        let Some(begin) = line.iter().position(|byte| *byte == b'{') else {
            // libtest 的计数、测试名称前缀和摘要不属于插件协议帧。
            continue;
        };
        // 有 JSON 起点后必须完整解析，不能把损坏的协议响应当作框架噪声跳过。
        return serde_json::from_slice(&line[begin..])
            .map_err(|_| "子进程协议 JSON 不完整".to_owned());
    }
    Err("测试框架非 JSON 行超过限定数量".into())
}

async fn bounded(mut reader: impl AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    (&mut reader)
        .take(DIAGNOSTIC_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "子进程收尾输出读取失败".to_owned())?;
    if bytes.len() > DIAGNOSTIC_LIMIT {
        return Err("子进程收尾输出超过限定字节数".into());
    }
    Ok(bytes)
}

async fn round(
    protocol: u32,
    operation: &str,
    iteration: usize,
    suite_deadline: Instant,
) -> Result<u32, String> {
    if Instant::now() >= suite_deadline {
        return Err("真实 stdio 回归总看门狗到期".into());
    }
    // 启动、握手、错误末帧和零退出共用一次截止点，不给不同阶段重新授时。
    let deadline = (Instant::now() + ROUND_LIMIT).min(suite_deadline);
    let executable = std::env::current_exe().map_err(|_| "无法定位本测试程序".to_owned())?;
    let mut child = Command::new(executable)
        .args([
            "--exact",
            CHILD_TEST,
            "--nocapture",
            "--test-threads=1",
            "--format=terse",
        ])
        .env(CHILD_ENV, protocol.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "无法启动专用 stdio 子测试".to_owned())?;
    let pid = child.id().expect("新启动子进程具有 PID");
    let mut stdin = Some(child.stdin.take().expect("已配置输入管道"));
    let mut stdout = BufReader::new(child.stdout.take().expect("已配置输出管道"));
    let stderr = child.stderr.take().expect("已配置诊断管道");
    let mut errors = tokio::spawn(bounded(stderr));
    let request_id = format!("stdio-{protocol}-{operation}-{iteration}");

    let attempt = timeout_at(deadline, async {
        send(
            stdin.as_mut().ok_or("请求前输入意外关闭")?,
            &json!({
                "protocol_version":protocol,
                "request_id":request_id,
                "operation":operation,
                "input":{}
            }),
        )
        .await?;
        if protocol == 4 {
            let ready = frame(&mut stdout).await?;
            if ready != json!({"protocol_version":4,"request_id":request_id,"command":"ready"}) {
                return Err("Ready 原帧或请求关联不匹配".to_owned());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            send(
                stdin.as_mut().ok_or("Start 前输入意外关闭")?,
                &json!({
                    "protocol_version":4,
                    "request_id":request_id,
                    "command":"start",
                    "remaining_timeout_ns":u64::try_from(remaining.as_nanos())
                        .map_err(|_| "测试剩余预算不可表示".to_owned())?
                }),
            )
            .await?;
        }

        // 此处不关闭输入，也不发送 Cancel；必须先读到匹配的完整错误末帧。
        let reply: CooperativeResponse = serde_json::from_value(frame(&mut stdout).await?)
            .map_err(|_| "错误末帧不符合合作响应契约".to_owned())?;
        if reply.response.protocol_version != protocol
            || reply.response.request_id != request_id
            || reply.response.error.as_deref() != Some(rejection(pid).as_str())
            || reply.response.result.is_some()
            || !reply.response.outputs.is_empty()
            || reply.cleanup != apk_plugin_sdk::cooperative::CleanupOutcome::Complete
        {
            return Err("错误末帧的协议、关联、PID、错误或清理声明不匹配".to_owned());
        }
        if stdin.is_none() {
            return Err("错误末帧到达前输入已经关闭".to_owned());
        }
        drop(stdin.take());

        let (status, tail, diagnostics) = tokio::try_join!(
            async {
                child
                    .wait()
                    .await
                    .map_err(|_| "无法等待专用子进程退出".to_owned())
            },
            bounded(&mut stdout),
            async {
                (&mut errors)
                    .await
                    .map_err(|_| "子进程诊断读取任务异常".to_owned())?
            },
        )?;
        if !status.success() {
            return Err(format!("专用子进程未零退出：{status}"));
        }
        if child.id().is_some() {
            return Err("专用子进程退出后仍未回收".to_owned());
        }
        if tail.contains(&b'{') || !diagnostics.is_empty() {
            return Err("错误末帧后存在额外 JSON 或错误诊断".to_owned());
        }
        Ok(())
    })
    .await;

    let failure = match attempt {
        Ok(Ok(())) => return Ok(pid),
        Ok(Err(error)) => error,
        Err(_) => "等待完整错误末帧或零退出超过本轮看门狗".into(),
    };
    // 失败收尾独立于业务预算，只清理本测试直接启动的子进程，不重试调用。
    drop(stdin.take());
    let cleanup = if child.id().is_some() {
        let kill = child.start_kill();
        match timeout_at(Instant::now() + CLEANUP_LIMIT, child.wait()).await {
            Ok(Ok(status)) => format!("子进程已回收，退出={status}，kill成功={}", kill.is_ok()),
            Ok(Err(_)) => "子进程回收失败，已保留 kill_on_drop".into(),
            Err(_) => "子进程回收看门狗到期，已保留 kill_on_drop".into(),
        }
    } else {
        "子进程已回收".into()
    };
    errors.abort();
    Err(format!("PID={pid}：{failure}；{cleanup}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fast_error_stdio_arrives_before_input_eof_and_child_exits_zero() {
    let suite_deadline = Instant::now() + SUITE_LIMIT;
    for protocol in [3, 4] {
        for operation in [IMMEDIATE, BLOCKING] {
            for iteration in 0..REPEATS {
                let pid = round(protocol, operation, iteration, suite_deadline)
                    .await
                    .unwrap_or_else(|error| {
                        panic!(
                            "真实 stdio 回归失败：协议={protocol}，路径={operation}，轮次={iteration}；{error}"
                        )
                    });
                eprintln!(
                    "真实 stdio 回归：协议={protocol}，路径={operation}，轮次={iteration}，PID={pid}，错误末帧=true，退出码=0，已回收=true"
                );
            }
        }
    }
}
