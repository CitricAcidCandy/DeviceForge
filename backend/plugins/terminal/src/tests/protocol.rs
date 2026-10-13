use super::*;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

struct Client {
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
    runtime: tokio::task::JoinHandle<std::result::Result<(), String>>,
    sequence: u64,
}

impl Client {
    async fn start(mode: &str, pid_file: &Path, budget_ns: u64) -> Self {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/terminal.cjs");
        let bytes = serde_json::to_vec(&json!({
            "format_version":1,
            "profiles":{"tool":{"executable":"node","args":[fixture,mode,pid_file],"resource_scope":"direct_process"}},
        })).unwrap();
        let config = config::Config::parse(&bytes).unwrap();
        let (host, plugin) = tokio::io::duplex(65_536);
        let (reader, writer) = tokio::io::split(host);
        let (plugin_reader, plugin_writer) = tokio::io::split(plugin);
        let runtime = tokio::spawn(deviceforge_plugin_runtime::session::serve_session_io(
            plugin_reader,
            plugin_writer,
            deviceforge_plugin_runtime::session::SessionOptions::default(),
            move |_, context, input, output| async move {
                session::run(
                    "tool".into(),
                    config.profile("tool").unwrap(),
                    context,
                    input,
                    output,
                )
                .await
            },
        ));
        let mut client = Self {
            reader: BufReader::new(reader),
            writer,
            runtime,
            sequence: 0,
        };
        client.send(json!({"protocol_version":5,"session_id":"terminal-case","command":"open","operation":"open","input":{"profile":"tool"}})).await;
        let ready = client.line().await;
        assert_eq!(ready["command"], "ready");
        assert_eq!(ready["session_id"], "terminal-case");
        client.send(json!({"protocol_version":5,"session_id":"terminal-case","command":"start","remaining_timeout_ns":budget_ns})).await;
        client
    }

    async fn send(&mut self, frame: Value) {
        let mut bytes = serde_json::to_vec(&frame).unwrap();
        bytes.push(b'\n');
        self.writer.write_all(&bytes).await.unwrap();
    }

    async fn line(&mut self) -> Value {
        let mut line = String::new();
        let size = tokio::time::timeout(Duration::from_secs(10), self.reader.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        assert!(size > 0);
        serde_json::from_str(&line).unwrap()
    }

    async fn event(&mut self) -> Value {
        let frame = self.line().await;
        self.sequence += 1;
        assert_eq!(frame["protocol_version"], 5);
        assert_eq!(frame["session_id"], "terminal-case");
        assert_eq!(frame["sequence"], self.sequence);
        frame
    }

    async fn until_stdout(&mut self, wanted: &[u8], events: &mut Vec<Value>) {
        loop {
            let frame = self.event().await;
            assert_eq!(frame["event"], "output");
            events.push(frame);
            if stream(events, "stdout")
                .windows(wanted.len())
                .any(|chunk| chunk == wanted)
            {
                break;
            }
        }
    }

    async fn finished(&mut self, events: &mut Vec<Value>) -> Value {
        loop {
            let frame = self.event().await;
            if frame["event"] == "finished" {
                return frame["outcome"].clone();
            }
            assert_eq!(frame["event"], "output");
            events.push(frame);
        }
    }

    async fn closed(self, pid_file: &Path) {
        self.runtime.await.unwrap().unwrap();
        let pid = tokio::fs::read_to_string(pid_file)
            .await
            .unwrap()
            .parse::<u32>()
            .unwrap();
        assert!(exited(pid), "终端会话终态交付后直接工具进程仍活动");
    }
}

fn stream(events: &[Value], name: &str) -> Vec<u8> {
    events
        .iter()
        .filter(|event| event["stream"] == name)
        .flat_map(|event| event["bytes"].as_array().unwrap().iter())
        .map(|byte| u8::try_from(byte.as_u64().unwrap()).unwrap())
        .collect()
}

#[cfg(windows)]
fn exited(pid: u32) -> bool {
    type Handle = *mut std::ffi::c_void;
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn GetExitCodeProcess(process: Handle, code: *mut u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetLastError() -> u32;
    }
    unsafe {
        let process = OpenProcess(0x1000, 0, pid);
        if process.is_null() {
            assert_eq!(GetLastError(), 87);
            return true;
        }
        let mut code = 259;
        let observed = GetExitCodeProcess(process, &mut code);
        CloseHandle(process);
        assert_ne!(observed, 0);
        code != 259
    }
}

#[cfg(unix)]
fn exited(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    let result = unsafe { kill(i32::try_from(pid).unwrap(), 0) };
    result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(3)
}

#[tokio::test]
async fn same_tool_emits_before_exit_accepts_multiple_binary_inputs_and_finishes_after_eof() {
    let directory = tempfile::tempdir().unwrap();
    let pid_file = directory.path().join("pid");
    let mut client = Client::start("echo", &pid_file, 15_000_000_000).await;
    let mut events = Vec::new();
    client
        .until_stdout(&[82, 69, 65, 68, 89, 0, 255], &mut events)
        .await;
    for bytes in [vec![65u8, 0, 255], vec![66u8, 254]] {
        client.send(json!({"protocol_version":5,"session_id":"terminal-case","command":"input","bytes":bytes})).await;
    }
    client
        .send(json!({"protocol_version":5,"session_id":"terminal-case","command":"eof"}))
        .await;
    let outcome = client.finished(&mut events).await;
    assert_eq!(outcome["cleanup"], "complete");
    assert_eq!(outcome["result"]["exit_code"], 0);
    assert_eq!(
        stream(&events, "stdout"),
        [
            82, 69, 65, 68, 89, 0, 255, 65, 0, 255, 66, 254, 69, 79, 70, 0
        ]
    );
    assert_eq!(stream(&events, "stderr"), [69, 82, 82, 0, 254]);
    assert_eq!(outcome["result"]["stdout_bytes"], 16);
    assert_eq!(outcome["result"]["stderr_bytes"], 5);
    client.closed(&pid_file).await;
}

#[tokio::test]
async fn nonzero_tool_exit_reports_actual_code_and_complete_direct_cleanup() {
    let directory = tempfile::tempdir().unwrap();
    let pid_file = directory.path().join("pid");
    let mut client = Client::start("nonzero", &pid_file, 15_000_000_000).await;
    let outcome = client.finished(&mut Vec::new()).await;
    assert_eq!(outcome["cleanup"], "complete");
    assert_eq!(outcome["error"], "终端工具退出码为Some(7)");
    assert!(outcome.get("result").is_none());
    client.closed(&pid_file).await;
}

#[tokio::test]
async fn eof_closes_stdin_but_cancel_still_reaches_same_live_tool() {
    let directory = tempfile::tempdir().unwrap();
    let pid_file = directory.path().join("pid");
    let mut client = Client::start("hang", &pid_file, 15_000_000_000).await;
    let mut events = Vec::new();
    client
        .until_stdout(&[82, 69, 65, 68, 89, 0, 255], &mut events)
        .await;
    client
        .send(json!({"protocol_version":5,"session_id":"terminal-case","command":"eof"}))
        .await;
    client.until_stdout(&[69, 79, 70, 0], &mut events).await;
    let pid = tokio::fs::read_to_string(&pid_file)
        .await
        .unwrap()
        .parse::<u32>()
        .unwrap();
    assert!(!exited(pid));
    client.send(json!({"protocol_version":5,"session_id":"terminal-case","command":"cancel","reason":"cancelled"})).await;
    let outcome = client.finished(&mut events).await;
    assert_eq!(outcome["cleanup"], "complete");
    assert!(outcome["error"].as_str().unwrap().contains("取消"));
    client.closed(&pid_file).await;
}

#[tokio::test]
async fn original_budget_stops_live_tool_and_waits_for_actual_direct_exit() {
    let directory = tempfile::tempdir().unwrap();
    let pid_file = directory.path().join("pid");
    let mut client = Client::start("hang", &pid_file, 1_000_000_000).await;
    let mut events = Vec::new();
    client
        .until_stdout(&[82, 69, 65, 68, 89, 0, 255], &mut events)
        .await;
    let outcome = client.finished(&mut events).await;
    assert_eq!(outcome["cleanup"], "complete");
    assert!(outcome["error"].as_str().unwrap().contains("期限"));
    client.closed(&pid_file).await;
}
