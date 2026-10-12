//! 只从公开协议发起业务，假工具隔离到每个场景的私有目录。
mod wire;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
    time::Duration,
};
pub use wire::Process;
pub use wire::alive;

struct Compiled {
    _root: tempfile::TempDir,
    executable: PathBuf,
}
fn executable() -> &'static Path {
    static COMPILED: OnceLock<Compiled> = OnceLock::new();
    &COMPILED
        .get_or_init(|| {
            let root = tempfile::tempdir().unwrap();
            let executable = root.path().join(if cfg!(windows) {
                "frida-tool.exe"
            } else {
                "frida-tool"
            });
            // 仅在主代理运行测试时编译夹具；编写阶段不运行rustc。
            let output = Command::new("rustc")
                .arg("--edition=2024")
                .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tool.rs"))
                .arg("-o")
                .arg(&executable)
                .output()
                .expect("主代理测试环境需要rustc");
            assert!(
                output.status.success(),
                "夹具编译失败：{}",
                String::from_utf8_lossy(&output.stderr)
            );
            Compiled {
                _root: root,
                executable,
            }
        })
        .executable
}

pub struct Fixture {
    pub root: tempfile::TempDir,
    pub tool: PathBuf,
    pub scratch: PathBuf,
    pub outputs: PathBuf,
    pub config: PathBuf,
}
impl Fixture {
    pub fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let tools = root.path().join("tools");
        let scratch = root.path().join("scratch");
        let outputs = root.path().join("outputs");
        for path in [&tools, &scratch, &outputs] {
            fs::create_dir(path).unwrap();
        }
        let tool = tools.join(executable().file_name().unwrap());
        fs::copy(executable(), &tool).unwrap();
        let config = root.path().join("frida.config.json");
        fs::write(
            &config,
            serde_json::to_vec(&json!({"format_version":1,
            "tools":{"adb":tool,"frida":tool,"frida_ps":tool},"scratch_root":scratch}))
            .unwrap(),
        )
        .unwrap();
        Self {
            root,
            tool,
            scratch,
            outputs,
            config,
        }
    }
    pub fn response(&self, index: usize, stdout: &[u8], stderr: &[u8], code: i32, released: bool) {
        let root = self.tool.parent().unwrap();
        fs::write(root.join(format!("stdout-{index}")), stdout).unwrap();
        fs::write(root.join(format!("stderr-{index}")), stderr).unwrap();
        fs::write(root.join(format!("code-{index}")), code.to_string()).unwrap();
        if released {
            self.release(index);
        }
    }
    pub fn release(&self, index: usize) {
        fs::write(
            self.tool.parent().unwrap().join(format!("release-{index}")),
            b"1",
        )
        .unwrap();
    }
    pub fn call(&self, index: usize) -> PathBuf {
        self.tool.parent().unwrap().join(format!("call-{index:02}"))
    }
    pub async fn wait_call(&self, index: usize) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while !self.call(index).join("ready").is_file() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("工具调用必须真实到达门闩");
    }
    pub fn argv(&self, index: usize) -> Vec<String> {
        let bytes = fs::read(self.call(index).join("argv.bin")).unwrap();
        let mut rest = bytes.as_slice();
        fn number(rest: &mut &[u8]) -> usize {
            let (head, tail) = rest.split_at(4);
            *rest = tail;
            u32::from_le_bytes(head.try_into().unwrap()) as usize
        }
        let count = number(&mut rest);
        let mut args = Vec::new();
        for _ in 0..count {
            let size = number(&mut rest);
            let (head, tail) = rest.split_at(size);
            rest = tail;
            args.push(String::from_utf8(head.to_vec()).unwrap());
        }
        assert!(rest.is_empty());
        args
    }
    pub fn stdin(&self, index: usize) -> String {
        fs::read_to_string(self.call(index).join("stdin.bin")).unwrap()
    }
    pub fn pid(&self, index: usize) -> u32 {
        fs::read_to_string(self.call(index).join("pid"))
            .unwrap()
            .parse()
            .unwrap()
    }
    pub fn artifact(&self, field: &str, id: &str, bytes: &[u8]) -> Value {
        let path = self.root.path().join("authorized-input.bin");
        fs::write(&path, bytes).unwrap();
        json!({"field":field,"artifact_id":id,"filename":"authorized.bin","path":path,"size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes))})
    }
    pub async fn start(&self, operation: &str, input: Value, artifacts: Vec<Value>) -> Process {
        self.start_with_budget(operation, input, artifacts, Duration::from_secs(8))
            .await
    }
    pub async fn start_with_budget(
        &self,
        operation: &str,
        input: Value,
        artifacts: Vec<Value>,
        budget: Duration,
    ) -> Process {
        Process::start(&self.config, json!({"protocol_version":4,"request_id":"frida-business","operation":operation,
            "input":{"device_id":"device-1","input":input},"artifacts":{"inputs":artifacts,"output_directory":self.outputs}}),budget).await
    }
    pub fn assert_outputs(&self, response: &Value, expected: &[&str]) {
        let actual: Vec<&str> = response["response"]["outputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["filename"].as_str().unwrap())
            .collect();
        assert_eq!(actual, expected);
        let result: Value =
            serde_json::from_slice(&fs::read(self.outputs.join("operation.json")).unwrap())
                .unwrap();
        assert_eq!(result, response["response"]["result"]);
        assert_eq!(fs::read_dir(&self.outputs).unwrap().count(), expected.len());
    }
    pub fn assert_clean(&self) {
        assert_eq!(
            fs::read_dir(&self.scratch).unwrap().count(),
            0,
            "本次私有目录须已回收"
        );
    }
}
pub fn success(response: &Value) -> &Value {
    assert_eq!(response["cleanup"], "complete");
    assert!(response["response"]["error"].is_null(), "{response}");
    &response["response"]["result"]
}
pub fn failure(response: &Value, cleanup: &str) {
    assert_eq!(response["cleanup"], cleanup);
    assert!(response["response"]["result"].is_null());
    assert!(
        response["response"]["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty()),
        "{response}"
    );
    assert!(
        response["response"]["outputs"]
            .as_array()
            .is_none_or(Vec::is_empty)
    );
}
