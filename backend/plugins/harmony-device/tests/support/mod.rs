//! 每场景独占原件目录，公开协议手写期望，独立工具记录实际副作用。
pub mod artifacts;
mod process;
mod wire;

pub use process::PidProbe;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
pub use wire::{Invocation, failure, success};

pub const SERIAL: &str = "HDC001:5555";
pub const PACKAGE: &str = "com.failed.example";
pub const CANCELLED: &str = "操作已取消或宿主连接已关闭";
pub const TOTAL_TIMEOUT: &str = "插件执行期限已到期";
pub const INSTALL_SUCCESS: &[u8] = b"msg:install bundle successfully.\n";
pub const UNINSTALL_SUCCESS: &[u8] = b"msg:uninstall bundle successfully.\n";
static ORDINAL: AtomicU64 = AtomicU64::new(0);
static TOOL: OnceLock<PathBuf> = OnceLock::new();

fn new_directory(label: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "deviceforge-hdc-{label}-{}-{stamp}-{}",
        std::process::id(),
        ORDINAL.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    fs::canonicalize(root).unwrap()
}

fn tool_binary() -> &'static Path {
    TOOL.get_or_init(|| {
        let root = new_directory("compiled");
        let executable = root.join(if cfg!(windows) {
            "hdc-fixture.exe"
        } else {
            "hdc-fixture"
        });
        let output = Command::new("rustc")
            .args(["--edition=2024", "--crate-name", "independent_fake_hdc"])
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/hdc.rs"))
            .arg("-o")
            .arg(&executable)
            .output()
            .expect("主代理测试环境需要rustc");
        fs::write(root.join("rustc.stdout"), &output.stdout).unwrap();
        fs::write(root.join("rustc.stderr"), &output.stderr).unwrap();
        assert!(output.status.success(), "假HDC编译失败，{}", root.display());
        executable
    })
    .as_path()
}

pub fn device(input: Value) -> Value {
    json!({"device_id":SERIAL, "input":input})
}

pub struct Fixture {
    pub root: PathBuf,
    pub config_path: PathBuf,
    pub config: Value,
}

impl Fixture {
    pub fn new(label: &str) -> Self {
        let root = new_directory(label);
        let executable = root.join(if cfg!(windows) {
            "假 HDC.exe"
        } else {
            "假 HDC"
        });
        fs::copy(tool_binary(), &executable).unwrap();
        let config_path = root.join("部署配置.json");
        let config = json!({"format_version":1,"tools":{"hdc":executable}});
        fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        Self {
            root,
            config_path,
            config,
        }
    }
    pub fn save_config(&self) {
        fs::write(&self.config_path, serde_json::to_vec(&self.config).unwrap()).unwrap();
    }
    pub fn request(&self, operation: &str, input: Value) -> Value {
        json!({"protocol_version":4,"request_id":format!("independent-{operation}"),
            "operation":operation,"input":input,
            "artifacts":{"inputs":[],"output_directory":self.root.join("unused-output")}})
    }
    pub fn begin(&self, operation: &str, input: Value) -> Invocation {
        self.begin_request(self.request(operation, input))
    }
    pub fn begin_request(&self, request: Value) -> Invocation {
        Invocation::spawn(&self.config_path, &self.root, request, true)
    }
    pub fn plan(&self, stdout: &[u8], stderr: &[u8], code: i32) {
        fs::write(self.root.join("stdout"), stdout).unwrap();
        fs::write(self.root.join("stderr"), stderr).unwrap();
        fs::write(self.root.join("code"), code.to_string()).unwrap();
    }
    pub fn wait_tool(&self) -> PidProbe {
        self.wait_tool_at(1)
    }
    pub fn plan_call(&self, ordinal: usize, stdout: &[u8], stderr: &[u8], code: i32) {
        let plan = self.root.join(format!("plan-{ordinal:02}"));
        fs::create_dir(&plan).unwrap();
        fs::write(plan.join("stdout"), stdout).unwrap();
        fs::write(plan.join("stderr"), stderr).unwrap();
        fs::write(plan.join("code"), code.to_string()).unwrap();
    }
    pub fn release_call(&self, ordinal: usize) {
        let plan = self.root.join(format!("plan-{ordinal:02}"));
        fs::write(plan.join("release.tmp"), b"1").unwrap();
        fs::rename(plan.join("release.tmp"), plan.join("release")).unwrap();
    }
    pub fn wait_tool_at(&self, ordinal: usize) -> PidProbe {
        self.wait_tool_at_with_deadline(ordinal, Instant::now() + Duration::from_secs(8))
    }
    pub fn wait_tool_at_with_deadline(
        &self,
        ordinal: usize,
        invocation_deadline: Instant,
    ) -> PidProbe {
        let call = self.root.join(format!("call-{ordinal:02}"));
        // 上一工具退出后插件仍可能在解码/校验；尚未派发不等于新工具启动失败。
        while !call.is_dir() {
            assert!(
                Instant::now() < invocation_deadline,
                "原调用预算内未派发HDC，{}",
                call.display()
            );
            thread::sleep(Duration::from_millis(5));
        }
        let deadline = invocation_deadline.min(Instant::now() + Duration::from_secs(8));
        while !call.join("ready").exists() {
            assert!(
                Instant::now() < deadline,
                "真实HDC未到ready，{}",
                call.display()
            );
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(fs::read(call.join("ready")).unwrap(), b"1");
        let pid = fs::read_to_string(call.join("pid"))
            .unwrap()
            .parse()
            .unwrap();
        let probe = PidProbe::open(pid, call.join("test-fallback-kill"));
        probe.assert_running();
        probe
    }
    pub fn release(&self) {
        fs::write(self.root.join("release.tmp"), b"1").unwrap();
        fs::rename(self.root.join("release.tmp"), self.root.join("release")).unwrap();
    }
    pub fn argv(&self) -> Vec<String> {
        self.argv_at(1)
    }
    pub fn argv_at(&self, ordinal: usize) -> Vec<String> {
        let bytes = fs::read(self.root.join(format!("call-{ordinal:02}/argv.bin"))).unwrap();
        let mut offset = 0;
        let integer = |offset: &mut usize| {
            let value = u32::from_le_bytes(bytes[*offset..*offset + 4].try_into().unwrap());
            *offset += 4;
            value as usize
        };
        let count = integer(&mut offset);
        assert!(count <= 16);
        let mut args = Vec::new();
        for _ in 0..count {
            let length = integer(&mut offset);
            assert!(length <= 8192);
            args.push(String::from_utf8(bytes[offset..offset + length].to_vec()).unwrap());
            offset += length;
        }
        assert_eq!(offset, bytes.len());
        args
    }
    pub fn assert_calls(&self, expected: usize) {
        let actual = fs::read_dir(&self.root)
            .unwrap()
            .map(|entry| entry.unwrap())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("call-"))
            .count();
        assert_eq!(actual, expected, "必须按实际工具启动证据核对");
    }
    pub fn run_request(&self, request: Value, stdout: &[u8], stderr: &[u8], code: i32) -> Value {
        self.plan(stdout, stderr, code);
        let mut running = self.begin_request(request);
        running.start(Duration::from_secs(20));
        let probe = self.wait_tool();
        self.release();
        let reply = running.complete();
        probe.assert_exited();
        self.assert_calls(1);
        reply
    }
    pub fn run(
        &self,
        operation: &str,
        input: Value,
        stdout: &[u8],
        stderr: &[u8],
        code: i32,
    ) -> Value {
        self.run_request(self.request(operation, input), stdout, stderr, code)
    }
    pub fn reject(&self, request: Value, expected: &str) {
        let mut running = self.begin_request(request);
        running.start(Duration::from_secs(20));
        failure(&running.complete(), expected);
        self.assert_calls(0);
        assert!(!self.root.join("unused-output").exists());
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        eprintln!("鸿蒙设备独立黑盒证据保留：{}", self.root.display());
    }
}

pub fn expected_device(id: &str) -> Value {
    json!({"id":id,"state":"online","raw_state":"device","capabilities":[
        {"id":"packages","version":1,"available":true},
        {"id":"app.install","version":1,"available":true},
        {"id":"app.uninstall","version":1,"available":true},
        {"id":"app.detail","version":1,"available":true},
        {"id":"app.start","version":1,"available":true},
        {"id":"app.stop","version":1,"available":true},
        {"id":"app.reset","version":1,"available":true},
        {"id":"screenshot","version":1,"available":true}
    ]})
}
