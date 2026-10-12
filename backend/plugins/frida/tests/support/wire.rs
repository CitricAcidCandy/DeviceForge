//! 管道严格刷新并保持输入开放；收到完整响应后才关闭输入和等待真实退出。
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    task::JoinHandle,
};

pub struct Process {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    diagnostics: Option<JoinHandle<Vec<u8>>>,
}
impl Process {
    pub async fn start(config: &Path, request: Value, budget: Duration) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_deviceforge-frida-plugin"))
            .arg("--config")
            .arg(config)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // 仅合成的非敏感标记，用于验证工具进程受限环境。
            .env("APK_API_TOKEN", "synthetic-marker")
            .env("ADB_SERVER_SOCKET", "synthetic-marker")
            .env("JAVA_TOOL_OPTIONS", "synthetic-marker")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let stderr = child.stderr.take().unwrap();
        let diagnostics = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stderr.take(65536).read_to_end(&mut bytes).await.unwrap();
            bytes
        });
        let mut process = Self {
            child,
            stdin: Some(stdin),
            stdout,
            diagnostics: Some(diagnostics),
        };
        process.send(&request).await;
        let ready = process.frame("Ready").await;
        assert_eq!(
            ready,
            json!({"protocol_version":4,"request_id":"frida-business","command":"ready"})
        );
        process
            .send(
                &json!({"protocol_version":4,"request_id":"frida-business","command":"start",
            "remaining_timeout_ns":u64::try_from(budget.as_nanos()).unwrap()}),
            )
            .await;
        process
    }
    async fn send(&mut self, frame: &Value) {
        let mut bytes = serde_json::to_vec(frame).unwrap();
        bytes.push(b'\n');
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(&bytes).await.unwrap();
        stdin.flush().await.unwrap();
    }
    async fn frame(&mut self, stage: &str) -> Value {
        let mut line = String::new();
        match tokio::time::timeout(Duration::from_secs(10), self.stdout.read_line(&mut line)).await
        {
            Ok(Ok(count)) if count > 0 => {
                serde_json::from_str(&line).expect("插件只输出完整公开JSON帧")
            }
            failure => {
                let status = self.child.try_wait().unwrap();
                let _ = self.child.kill().await;
                self.stdin.take();
                let _ = self.child.wait().await;
                let bytes = self.diagnostics.take().unwrap().await.unwrap();
                panic!(
                    "{stage}未到达：{failure:?}；终止前状态={status:?}；stderr={}",
                    String::from_utf8_lossy(&bytes)
                );
            }
        }
    }
    pub async fn cancel(&mut self) {
        self.send(&json!({"protocol_version":4,"request_id":"frida-business","command":"cancel","reason":"cancelled"})).await;
    }
    pub async fn response(mut self) -> Value {
        let response = self.frame("业务响应").await;
        assert_eq!(response["response"]["protocol_version"], 4);
        assert_eq!(response["response"]["request_id"], "frida-business");
        self.stdin.take();
        let status = tokio::time::timeout(Duration::from_secs(10), self.child.wait())
            .await
            .expect("真实插件须在输入关闭后退出")
            .unwrap();
        let bytes = self.diagnostics.take().unwrap().await.unwrap();
        assert!(
            status.success(),
            "插件退出失败：{status}；stderr={}",
            String::from_utf8_lossy(&bytes)
        );
        assert!(
            bytes.is_empty(),
            "stderr={}",
            String::from_utf8_lossy(&bytes)
        );
        let mut remainder = Vec::new();
        self.stdout.read_to_end(&mut remainder).await.unwrap();
        assert!(remainder.is_empty(), "协议完成后不得夹带额外stdout");
        response
    }
}

#[cfg(windows)]
pub fn alive(pid: u32) -> bool {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn GetExitCodeProcess(handle: *mut std::ffi::c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    // 只读观察本测试获得的PID，不枚举、不发送终止信号。
    unsafe {
        let handle = OpenProcess(0x1000, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0;
        let read = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        read != 0 && code == 259
    }
}
#[cfg(unix)]
pub fn alive(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    // 信号0仅观察本测试PID是否存在，不改变进程状态。
    unsafe { kill(i32::try_from(pid).unwrap(), 0) == 0 }
}
