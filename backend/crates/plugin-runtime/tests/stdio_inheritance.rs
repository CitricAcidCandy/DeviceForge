//! 后代存活时插件传输仍须结束；不允许后代持有宿主协议管道。
#![cfg(windows)]

#[path = "stdio_inheritance/support.rs"]
mod support;

use apk_plugin_sdk::session::{SessionOpen, SessionStart};
use deviceforge_plugin_runtime::{
    Execution, SessionOptions, serve_once, serve_once_with_context, serve_session,
};
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    time::{Instant, sleep, timeout},
};

const MODE: &str = "DEVICEFORGE_STDIO_INHERITANCE_MODE";
const ROOT: &str = "DEVICEFORGE_STDIO_INHERITANCE_ROOT";

#[test]
fn stdio_inheritance_child() {
    let Ok(mode) = std::env::var(MODE) else {
        return;
    };
    let root = PathBuf::from(std::env::var_os(ROOT).expect("独占测试目录"));
    if mode == "descendant" {
        let end = std::time::Instant::now() + Duration::from_secs(30);
        fs::write(
            root.join("descendant.pending"),
            std::process::id().to_string(),
        )
        .expect("记录自有后代PID");
        fs::rename(root.join("descendant.pending"), root.join("descendant.pid"))
            .expect("原子发布后代PID");
        while !root.join("release").exists() && std::time::Instant::now() < end {
            std::thread::sleep(Duration::from_millis(10));
        }
        fs::write(root.join("descendant.done"), b"done").expect("记录后代终态");
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("创建标准流测试运行时");
    runtime
        .block_on(async {
            let handler = move || async move {
                let root_for_launch = root.clone();
                tokio::task::spawn_blocking(move || {
                    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
                    command
                        .args(["--exact", "stdio_inheritance_child", "--nocapture"])
                        .env(MODE, "descendant")
                        .env(ROOT, &root_for_launch)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null());
                    use std::os::windows::process::CommandExt;
                    command.creation_flags(0x0800_0000);
                    let mut child = command.spawn().expect("启动本测试后代");
                    eprintln!("本次后代PID={}，由父测试释放", child.id());
                    // 此等待线程不延长插件寿命；父测试另持原生句柄并负责释放后代。
                    std::thread::spawn(move || child.wait().expect("等待本次后代退出"));
                })
                .await
                .expect("后代启动工作结束");
                let end = Instant::now() + Duration::from_secs(5);
                while !root.join("descendant.pid").exists() {
                    assert!(Instant::now() < end, "后代必须就绪");
                    sleep(Duration::from_millis(10)).await;
                }
                Execution::complete(Ok(json!({"ready":true}).into()))
            };
            if mode == "5" {
                serve_session(SessionOptions::default(), |_, _, _, _| handler()).await
            } else if mode == "4" {
                serve_once_with_context(|_, _| handler()).await
            } else {
                serve_once(|_, _| handler()).await
            }
        })
        .expect("标准流协议交付完成");
    // 真正销毁运行时，不能用进程立即退出跳过阻塞读取回收。
    drop(runtime);
}

async fn frame(reader: &mut BufReader<tokio::process::ChildStdout>) -> Result<Value, String> {
    for _ in 0..16 {
        let mut line = String::new();
        let size = reader
            .read_line(&mut line)
            .await
            .map_err(|error| error.to_string())?;
        if size == 0 || size > 4096 {
            return Err("协议帧前EOF或单行超过限额".into());
        }
        if let Some(start) = line.find('{') {
            return serde_json::from_str(&line[start..]).map_err(|error| error.to_string());
        }
    }
    Err("测试框架前缀行数超限".into())
}

async fn send(input: &mut Option<tokio::process::ChildStdin>, value: Value) -> Result<(), String> {
    input
        .as_mut()
        .ok_or("输入意外关闭")?
        .write_all(format!("{value}\n").as_bytes())
        .await
        .map_err(|error| error.to_string())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stdio_transport_does_not_leak_to_live_descendants() {
    for protocol in [3, 4, 5] {
        let root = std::env::temp_dir().join(format!(
            "deviceforge-stdio-inheritance-{}-{protocol}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        fs::create_dir(&root).expect("创建本轮独占目录");
        let mut descendant = support::Descendant::new(root.clone());
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "stdio_inheritance_child",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(MODE, protocol.to_string())
            .env(ROOT, &root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x0800_0000)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        descendant.assign(&child);
        let pid = child.id().unwrap();
        let mut input = child.stdin.take();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut errors = child.stderr.take().unwrap();
        let attempt = timeout(Duration::from_secs(6), async {
            let request = if protocol == 5 {
                json!(SessionOpen::new("inheritance", "check", json!({})))
            } else {
                json!({"protocol_version":protocol,"request_id":"inheritance", "operation":"check","input":{}})
            };
            send(&mut input, request).await?;
            if protocol >= 4 {
                if frame(&mut output).await?["command"] != "ready" {
                    return Err("未收到Ready".to_owned());
                }
                let start = if protocol == 5 {
                    json!(SessionStart::new("inheritance", 5_000_000_000))
                } else {
                    json!({"protocol_version":4,"request_id":"inheritance","command":"start",
                        "remaining_timeout_ns":5_000_000_000_u64})
                };
                send(&mut input, start).await?;
            }
            let reply = frame(&mut output).await?;
            let (outcome, cleanup) = if protocol == 5 {
                if reply["event"] != "finished" || reply["session_id"] != "inheritance" {
                    return Err("会话末帧不匹配".into());
                }
                (&reply["outcome"], &reply["outcome"]["cleanup"])
            } else {
                if reply["response"]["protocol_version"] != protocol ||
                    reply["response"]["request_id"] != "inheritance" {
                    return Err("普通响应关联不匹配".into());
                }
                (&reply["response"], &reply["cleanup"])
            };
            if outcome["result"]["ready"] != true || cleanup != "complete" {
                return Err("完整响应或清理声明不匹配".into());
            }
            descendant.observe()?;
            drop(input.take());
            let mut tail = Vec::new();
            let mut diagnostics = Vec::new();
            let (status, out_read, err_read) = tokio::join!(
                child.wait(), output.read_to_end(&mut tail), errors.read_to_end(&mut diagnostics)
            );
            out_read.map_err(|error| format!("标准输出未完整EOF：{error}"))?;
            err_read.map_err(|error| format!("标准错误未完整EOF：{error}"))?;
            if !status.map_err(|error| error.to_string())?.success() {
                return Err("插件未真实零退出".into());
            }
            descendant.require_running()?;
            Ok::<_, String>(())
        }).await;
        drop(input.take());
        if child.id().is_some() {
            let _ = child.start_kill();
            timeout(Duration::from_secs(3), child.wait())
                .await
                .expect("回收插件")
                .unwrap();
        }
        let descendant_cleanup = descendant.finish();
        eprintln!(
            "协议={protocol} 插件PID={pid} 后代PID={:?} 回收={descendant_cleanup:?}",
            descendant.pid
        );
        descendant_cleanup.expect("精确进程句柄确认后代已退出");
        attempt
            .expect("后代继承了宿主协议管道，导致EOF或退出超时")
            .expect("管道或响应验证失败");
    }
}
