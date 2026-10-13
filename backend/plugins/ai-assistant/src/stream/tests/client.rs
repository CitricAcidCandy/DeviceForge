use super::*;
use apk_plugin_sdk::session::SessionEvent;
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

static NEXT: AtomicU64 = AtomicU64::new(1);

pub(super) struct Client {
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
    runtime: tokio::task::JoinHandle<Result<(), String>>,
    session_id: String,
    sequence: u64,
    pub wire: Vec<u8>,
    pub pid_file: PathBuf,
}

pub(super) fn project(root: &Path) -> PathBuf {
    let project = root.join("project");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(
        project.join("exec"),
        include_bytes!("../../../tests/fixtures/stream.cjs"),
    )
    .unwrap();
    std::fs::canonicalize(project).unwrap()
}

impl Client {
    pub(super) async fn start(root: &Path, mode: &str, budget_ns: u64, input: Value) -> Self {
        let project = project(root);
        let session_id = format!("stream-{}", NEXT.fetch_add(1, Ordering::Relaxed));
        let pid_file = root.join(format!("{session_id}.pid"));
        let config = config::Config {
            format_version: 1,
            executable: "node".into(),
            args: Vec::new(),
            projects: BTreeMap::from([("demo".into(), project)]),
            environment: BTreeMap::from([
                ("AI_FIXTURE_PID".into(), pid_file.to_str().unwrap().into()),
                ("AI_FIXTURE_MODE".into(), mode.into()),
                ("AI_SECRET".into(), "secret-sentinel".into()),
            ]),
            state_root: root.join("state"),
        };
        let (host, plugin) = tokio::io::duplex(65536);
        let (reader, writer) = tokio::io::split(host);
        let (plugin_reader, plugin_writer) = tokio::io::split(plugin);
        let runtime = tokio::spawn(deviceforge_plugin_runtime::session::serve_session_io(
            plugin_reader,
            plugin_writer,
            deviceforge_plugin_runtime::session::SessionOptions::default(),
            move |open, context, input, output| {
                execute_configured(open, context, input, output, async move { Ok(config) })
            },
        ));
        let mut client = Self {
            reader: BufReader::new(reader),
            writer,
            runtime,
            session_id,
            sequence: 0,
            wire: Vec::new(),
            pid_file,
        };
        client.send(json!({"protocol_version":5,"session_id":client.session_id,"command":"open","operation":"cli.stream","input":input})).await;
        let ready = client.line().await;
        assert_eq!(ready["command"], "ready");
        assert_eq!(ready["session_id"], client.session_id);
        client.send(json!({"protocol_version":5,"session_id":client.session_id,"command":"start","remaining_timeout_ns":budget_ns})).await;
        client
    }

    pub(super) async fn control(&mut self, command: &str, bytes: Option<Vec<u8>>) {
        let mut frame =
            json!({"protocol_version":5,"session_id":self.session_id,"command":command});
        if let Some(bytes) = bytes {
            frame["bytes"] = json!(bytes);
        }
        if command == "cancel" {
            frame["reason"] = json!("cancelled");
        }
        self.send(frame).await;
    }

    async fn send(&mut self, value: Value) {
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

    async fn frame(&mut self) -> Value {
        let frame = self.line().await;
        let event: SessionEvent = serde_json::from_value(frame.clone()).unwrap();
        event.validate().unwrap();
        self.sequence += 1;
        assert_eq!(frame["session_id"], self.session_id);
        assert_eq!(frame["sequence"], self.sequence);
        if frame["event"] == "output" {
            assert_eq!(frame["stream"], "stdout");
            self.wire.extend(
                frame["bytes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|byte| u8::try_from(byte.as_u64().unwrap()).unwrap()),
            );
        }
        frame
    }

    pub(super) fn events(&self) -> Vec<Value> {
        let Some(last) = self.wire.iter().rposition(|byte| *byte == b'\n') else {
            return Vec::new();
        };
        std::str::from_utf8(&self.wire[..=last])
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    pub(super) async fn until(&mut self, kind: &str) {
        while !self.events().iter().any(|event| event["type"] == kind) {
            assert_eq!(self.frame().await["event"], "output");
        }
    }

    pub(super) async fn finished(mut self) -> (Value, Vec<Value>) {
        let outcome = loop {
            let frame = self.frame().await;
            if frame["event"] == "finished" {
                break frame["outcome"].clone();
            }
        };
        let events = self.events();
        assert!(!String::from_utf8_lossy(&self.wire).contains("secret-sentinel"));
        assert!(!String::from_utf8_lossy(&self.wire).contains("hidden-"));
        assert!(!outcome.to_string().contains("secret-sentinel"));
        self.runtime.await.unwrap().unwrap();
        if let Ok(pid) = std::fs::read_to_string(&self.pid_file) {
            assert!(exited(pid.parse().unwrap()));
        }
        (outcome, events)
    }
}

#[cfg(windows)]
pub(super) fn exited(pid: u32) -> bool {
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
pub(super) fn exited(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    let result = unsafe { kill(i32::try_from(pid).unwrap(), 0) };
    result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(3)
}
