//! 手工 JSON 原帧客户端；不使用 SDK 序列化或宿主 ProcessPlugin。
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
    Invalid(String),
}

pub struct Invocation {
    child: Child,
    input: Option<ChildStdin>,
    frames: Receiver<Frame>,
    stdout: Option<JoinHandle<()>>,
    stderr: Option<JoinHandle<Vec<u8>>>,
    evidence: PathBuf,
    id: String,
    finished: bool,
}

impl Invocation {
    pub fn spawn(config: &Path, directory: &Path, request: Value) -> Self {
        assert!(config.is_absolute(), "部署配置必须是绝对路径");
        Self::spawn_config_arg(config, directory, request)
    }
    pub fn spawn_config_arg(config: &Path, directory: &Path, request: Value) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_deviceforge-android-packages-plugin"))
            .arg("--config")
            .arg(config)
            .current_dir(directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("启动本次插件真实二进制");
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let errors = child.stderr.take().unwrap();
        let (send, frames) = mpsc::channel();
        let evidence = directory.join("wire");
        fs::create_dir(&evidence).unwrap();
        fs::write(evidence.join("plugin.pid"), child.id().to_string()).unwrap();
        let output_path = evidence.join("stdout.jsonl");
        let stdout = thread::spawn(move || {
            let mut reader = BufReader::new(output.take(2 * 1024 * 1024 + 1));
            let mut raw = fs::File::create(output_path).unwrap();
            loop {
                let mut bytes = Vec::new();
                match reader.read_until(b'\n', &mut bytes) {
                    Ok(0) => {
                        let _ = send.send(Frame::End);
                        break;
                    }
                    Ok(_) => {
                        raw.write_all(&bytes).unwrap();
                        if bytes.len() > 1024 * 1024 || bytes.last() != Some(&b'\n') {
                            let _ = send.send(Frame::Invalid("响应帧未换行或超过一 MiB".into()));
                            break;
                        }
                        match serde_json::from_slice(&bytes) {
                            Ok(value) => {
                                if send.send(Frame::Json(value)).is_err() {
                                    break;
                                }
                            }
                            Err(error) => {
                                let _ = send.send(Frame::Invalid(error.to_string()));
                                break;
                            }
                        }
                    }
                    Err(error) => {
                        let _ = send.send(Frame::Invalid(error.to_string()));
                        break;
                    }
                }
            }
        });
        let stderr = thread::spawn(move || {
            let mut reader = errors;
            let mut tail = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let count = reader.read(&mut buffer).expect("读取本次插件诊断");
                if count == 0 {
                    break;
                }
                tail.extend_from_slice(&buffer[..count]);
                if tail.len() > 65536 {
                    tail.drain(..tail.len() - 65536);
                }
            }
            tail
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
            finished: false,
        };
        running.send(&request);
        assert_eq!(
            running.frame(),
            json!({"protocol_version":4,"request_id":running.id,"command":"ready"}),
            "真实插件 Ready 必须匹配本次 Request"
        );
        running
    }
    pub fn send(&mut self, value: &Value) {
        let mut bytes = serde_json::to_vec(value).unwrap();
        bytes.push(b'\n');
        self.input.as_mut().unwrap().write_all(&bytes).unwrap();
        self.input.as_mut().unwrap().flush().unwrap();
        let mut log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.evidence.join("stdin.jsonl"))
            .unwrap();
        log.write_all(&bytes).unwrap();
    }
    pub fn start(&mut self, remaining: Duration) {
        self.send(
            &json!({"protocol_version":4,"request_id":self.id,"command":"start",
            "remaining_timeout_ns":u64::try_from(remaining.as_nanos()).unwrap()}),
        );
    }
    pub fn cancel(&mut self, reason: &str) {
        self.send(
            &json!({"protocol_version":4,"request_id":self.id,"command":"cancel","reason":reason}),
        );
    }
    pub fn eof(&mut self) {
        self.input.take();
    }
    pub fn frame(&self) -> Value {
        match self
            .frames
            .recv_timeout(Duration::from_secs(10))
            .expect("原帧墙钟看门狗只防卡死")
        {
            Frame::Json(value) => value,
            Frame::End => panic!("插件在响应之前关闭 stdout"),
            Frame::Invalid(error) => panic!("真实原帧无效：{error}"),
        }
    }
    pub fn complete(mut self) -> Value {
        let reply = self.frame();
        assert_eq!(reply["response"]["protocol_version"], 4);
        assert_eq!(reply["response"]["request_id"], self.id);
        self.eof();
        let limit = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < limit, "本次插件直接 PID 未正常退出");
            thread::sleep(Duration::from_millis(5));
        };
        fs::write(self.evidence.join("plugin.exit.json"), serde_json::to_vec(&json!({
            "pid":self.child.id(),"request_id":self.id,"code":status.code(),"normal":status.success(),"test_kill":false
        })).unwrap()).unwrap();
        assert!(status.success(), "协议处理后的真实插件退出应为零：{status}");
        self.stdout.take().unwrap().join().unwrap();
        assert!(
            matches!(
                self.frames.recv_timeout(Duration::from_secs(1)),
                Ok(Frame::End)
            ),
            "单请求只有一个合作响应"
        );
        let stderr = self.stderr.take().unwrap().join().unwrap();
        fs::write(self.evidence.join("stderr.txt"), &stderr).unwrap();
        self.finished = true;
        reply
    }
    pub fn reject_handshake(mut self, expected: &str) {
        self.eof();
        let limit = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < limit, "坏握手后的本次插件 PID 未退出");
            thread::sleep(Duration::from_millis(5));
        };
        fs::write(self.evidence.join("plugin.exit.json"), serde_json::to_vec(&json!({
            "pid":self.child.id(),"request_id":self.id,"code":status.code(),"normal":status.success(),"test_kill":false
        })).unwrap()).unwrap();
        assert_eq!(status.code(), Some(1), "协议拒绝不是合作业务错误");
        self.stdout.take().unwrap().join().unwrap();
        assert!(
            matches!(
                self.frames.recv_timeout(Duration::from_secs(1)),
                Ok(Frame::End)
            ),
            "坏 Start 不得伪造业务响应"
        );
        let stderr = self.stderr.take().unwrap().join().unwrap();
        fs::write(self.evidence.join("stderr.txt"), &stderr).unwrap();
        assert_eq!(String::from_utf8(stderr).unwrap().trim(), expected);
        self.finished = true;
    }
}

impl Drop for Invocation {
    fn drop(&mut self) {
        if !self.finished {
            // 仅失败测试的兜底，不能据此把业务 cleanup 或派生资源写成通过。
            self.input.take();
            let _ = self.child.kill();
            let _ = self.child.wait();
            if let Some(output) = self.stdout.take() {
                let _ = output.join();
            }
            if let Some(errors) = self.stderr.take()
                && let Ok(bytes) = errors.join()
            {
                let _ = fs::write(self.evidence.join("stderr.txt"), bytes);
            }
            let _ = fs::write(self.evidence.join("test-fallback-kill.txt"), b"1");
        }
    }
}

pub fn success(reply: &Value) -> &Value {
    assert_eq!(
        reply["cleanup"], "complete",
        "合作确认与 OS PID 退出分别核对"
    );
    let response = &reply["response"];
    assert!(
        response.get("error").is_none(),
        "正常业务不得带 error：{reply}"
    );
    let value = response.get("result").expect("成功响应需要业务值");
    assert!(
        value.get("artifacts").is_none(),
        "业务值不能伪造宿主产物包装"
    );
    value
}
pub fn failure(reply: &Value, expected: &str) {
    assert_eq!(reply["cleanup"], "complete");
    assert_eq!(
        reply["response"]["error"], expected,
        "错误文案必须精确匹配冻结映射"
    );
    assert!(
        reply["response"].get("result").is_none(),
        "失败不得返回成功摘要"
    );
    assert!(
        reply["response"]
            .get("outputs")
            .is_none_or(|outputs| outputs.as_array().unwrap().is_empty()),
        "失败不得声明输出"
    );
}
pub fn output_names(reply: &Value) -> Vec<&str> {
    reply["response"]
        .get("outputs")
        .map_or(Vec::new(), |outputs| {
            outputs
                .as_array()
                .unwrap()
                .iter()
                .map(|output| {
                    assert_eq!(output.as_object().unwrap().len(), 1);
                    output["filename"].as_str().unwrap()
                })
                .collect()
        })
}
