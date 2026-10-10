//! 手写Request/Start/Cancel并记录实际原帧；不借SDK序列化或内部hook。
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

enum Frame {
    Json(Value),
    End,
    Invalid,
}
pub struct Invocation {
    child: Child,
    input: Option<ChildStdin>,
    frames: Receiver<Frame>,
    stdout: Option<JoinHandle<()>>,
    stderr: Option<JoinHandle<Vec<u8>>>,
    evidence: PathBuf,
    id: String,
    pub ready_observed: Instant,
    finished: bool,
}
impl Invocation {
    pub fn spawn(config: &Path, root: &Path, request: Value, expect_ready: bool) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_deviceforge-android-device-plugin"))
            .args(["--config"])
            .arg(config)
            .current_dir(root)
            .env("APK_ADB", "must_not_be_inherited")
            .env("ADB_SERVER_SOCKET", "must_not_be_inherited")
            .env("ANDROID_ADB_SERVER_PORT", "must_not_be_inherited")
            .env("APK_API_TOKEN", "independent-fixture-only-not-a-token")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let errors = child.stderr.take().unwrap();
        let evidence = root.join("wire");
        fs::create_dir(&evidence).unwrap();
        fs::write(evidence.join("plugin.pid"), child.id().to_string()).unwrap();
        let output_path = evidence.join("stdout.jsonl");
        let (send, frames) = mpsc::channel();
        let stdout = thread::spawn(move || {
            let mut reader = BufReader::new(output.take(2 * 1024 * 1024 + 1));
            let mut retained = fs::File::create(output_path).unwrap();
            loop {
                let mut bytes = Vec::new();
                match reader.read_until(b'\n', &mut bytes) {
                    Ok(0) => {
                        let _ = send.send(Frame::End);
                        break;
                    }
                    Ok(_) => {
                        retained.write_all(&bytes).unwrap();
                        if bytes.len() > 1024 * 1024 || bytes.last() != Some(&b'\n') {
                            let _ = send.send(Frame::Invalid);
                            break;
                        }
                        match serde_json::from_slice(&bytes) {
                            Ok(value) => {
                                if send.send(Frame::Json(value)).is_err() {
                                    break;
                                }
                            }
                            Err(_) => {
                                let _ = send.send(Frame::Invalid);
                                break;
                            }
                        }
                    }
                    Err(_) => {
                        let _ = send.send(Frame::Invalid);
                        break;
                    }
                }
            }
        });
        let stderr = thread::spawn(move || {
            let mut bytes = Vec::new();
            let mut reader = errors;
            let mut chunk = [0; 4096];
            loop {
                let count = reader.read(&mut chunk).unwrap();
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..count]);
                if bytes.len() > 65536 {
                    bytes.drain(..bytes.len() - 65536);
                }
            }
            bytes
        });
        let id = request["request_id"].as_str().unwrap().to_owned();
        let mut running = Self {
            child,
            input: Some(input),
            frames,
            stdout: Some(stdout),
            stderr: Some(stderr),
            evidence,
            id,
            ready_observed: Instant::now(),
            finished: false,
        };
        running.send(&request);
        if expect_ready {
            assert_eq!(
                running.frame(),
                json!({"protocol_version":4,"request_id":running.id,"command":"ready"})
            );
            running.ready_observed = Instant::now();
        }
        running
    }
    pub fn send(&mut self, value: &Value) {
        self.send_batch(std::slice::from_ref(value));
    }
    pub fn send_batch(&mut self, values: &[Value]) {
        let mut bytes = Vec::new();
        for value in values {
            bytes.extend_from_slice(&serde_json::to_vec(value).unwrap());
            bytes.push(b'\n');
        }
        self.input.as_mut().unwrap().write_all(&bytes).unwrap();
        self.input.as_mut().unwrap().flush().unwrap();
        let mut log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.evidence.join("stdin.jsonl"))
            .unwrap();
        log.write_all(&bytes).unwrap();
    }
    pub fn start_frame(&self, remaining: Duration) -> Value {
        json!({"protocol_version":4,"request_id":self.id,"command":"start",
            "remaining_timeout_ns":u64::try_from(remaining.as_nanos()).unwrap()})
    }
    pub fn cancel_frame(&self, reason: &str) -> Value {
        json!({"protocol_version":4,"request_id":self.id,"command":"cancel","reason":reason})
    }
    pub fn start(&mut self, remaining: Duration) {
        self.send(&self.start_frame(remaining));
    }
    pub fn cancel(&mut self, reason: &str) {
        self.send(&self.cancel_frame(reason));
    }
    pub fn eof(&mut self) {
        self.input.take();
    }
    pub fn frame(&self) -> Value {
        match self
            .frames
            .recv_timeout(Duration::from_secs(12))
            .expect("原帧墙钟看门狗仅防卡死")
        {
            Frame::Json(value) => value,
            Frame::End => panic!("本次插件没有业务响应"),
            Frame::Invalid => panic!("响应必须为有界换行JSON原帧"),
        }
    }
    fn finish(&mut self, code: i32) -> Vec<u8> {
        self.eof();
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "本次真实插件PID未退出");
            thread::sleep(Duration::from_millis(5));
        };
        fs::write(
            self.evidence.join("plugin.exit.json"),
            serde_json::to_vec(&json!({"pid":self.child.id(),"request_id":self.id,
            "code":status.code(),"test_kill":false}))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(status.code(), Some(code));
        self.stdout.take().unwrap().join().unwrap();
        assert!(
            matches!(
                self.frames.recv_timeout(Duration::from_secs(1)),
                Ok(Frame::End)
            ),
            "不能多发响应或丢失EOF"
        );
        let bytes = self.stderr.take().unwrap().join().unwrap();
        fs::write(self.evidence.join("stderr.txt"), &bytes).unwrap();
        self.finished = true;
        bytes
    }
    pub fn complete(mut self) -> Value {
        let reply = self.frame();
        assert_eq!(reply.as_object().unwrap().len(), 2);
        assert_eq!(reply["response"]["protocol_version"], 4);
        assert_eq!(reply["response"]["request_id"], self.id);
        let _ = self.finish(0);
        reply
    }
    pub fn reject_transport(mut self, expected: &str) {
        let stderr = self.finish(1);
        assert_eq!(String::from_utf8(stderr).unwrap().trim(), expected);
    }
}
impl Drop for Invocation {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.input.take();
        let deadline = Instant::now() + Duration::from_secs(3);
        while self.child.try_wait().is_ok_and(|status| status.is_none())
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(5));
        }
        if self.child.try_wait().is_ok_and(|status| status.is_none()) {
            // 失败兜底只杀本次直接插件；标记不能计入成功或资源树清理证据。
            let _ = fs::write(self.evidence.join("test-fallback-kill"), b"1");
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        if let Some(output) = self.stdout.take() {
            let _ = output.join();
        }
        if let Some(errors) = self.stderr.take()
            && let Ok(bytes) = errors.join()
        {
            let _ = fs::write(self.evidence.join("stderr.txt"), bytes);
        }
    }
}

pub fn success(reply: &Value) -> &Value {
    assert_eq!(reply["cleanup"], "complete");
    assert!(reply["response"].get("error").is_none());
    assert!(reply["response"].get("outputs").is_none());
    let result = reply["response"].get("result").unwrap();
    assert!(
        result.get("artifacts").is_none(),
        "业务值不得伪造宿主产物包装"
    );
    result
}
pub fn failure(reply: &Value, expected: &str) {
    assert_eq!(reply["cleanup"], "complete");
    assert_eq!(reply["response"]["error"], expected);
    assert!(reply["response"].get("result").is_none());
    assert!(reply["response"].get("outputs").is_none());
}
