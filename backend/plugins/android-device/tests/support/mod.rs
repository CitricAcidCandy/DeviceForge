//! 有界原帧、独立工具与每场景私有证据目录；不调用生产规则生成期望。
mod process;
mod wire;

use process::PidProbe;
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

pub const SERIAL: &str = "设备 一号:@%";
pub const ADDRESS: &str = "[::1]:5555";
pub const PACKAGE: &str = "com.failed.example";
pub const TOTAL_TIMEOUT: &str = "插件执行期限已到期";
pub const CANCELLED: &str = "操作已取消或宿主连接已关闭";
pub const ACTION_FAILURE: &str = "工具依赖失败：ADB动作未满足成功响应条件";
pub const INPUT_FAILURE: &str = "工具依赖失败：设备输入命令未返回空响应";
pub const BAD_UTF8: &str = "工具依赖失败：ADB输出不是有效UTF-8文本";

static ORDINAL: AtomicU64 = AtomicU64::new(0);
static TOOL: OnceLock<PathBuf> = OnceLock::new();

fn new_directory(label: &str) -> PathBuf {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "deviceforge-adb-{label}-{}-{time}-{}",
        std::process::id(),
        ORDINAL.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&path).unwrap();
    fs::canonicalize(path).unwrap()
}

fn tool_binary() -> &'static Path {
    TOOL.get_or_init(|| {
        let root = new_directory("compiled");
        let executable = root.join(if cfg!(windows) {
            "adb-fixture.exe"
        } else {
            "adb-fixture"
        });
        // 只在主代理运行测试时编译std-only夹具，当前编写不运行rustc或任何项目命令。
        let output = Command::new("rustc")
            .args(["--edition=2024", "--crate-name", "independent_fake_adb"])
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/adb.rs"))
            .arg("-o")
            .arg(&executable)
            .output()
            .expect("主代理测试环境需要rustc");
        fs::write(root.join("rustc.stdout"), &output.stdout).unwrap();
        fs::write(root.join("rustc.stderr"), &output.stderr).unwrap();
        assert!(
            output.status.success(),
            "假工具编译失败，证据目录 {}",
            root.display()
        );
        executable
    })
    .as_path()
}

pub fn envelope(serial: Option<&str>, input: Value) -> Value {
    json!({"device_id":serial,"input":input})
}
pub fn device(input: Value) -> Value {
    envelope(Some(SERIAL), input)
}
pub fn provider(input: Value) -> Value {
    envelope(None, input)
}
pub fn input(action: Value) -> Value {
    device(json!({"action":action}))
}

pub struct Fixture {
    pub root: PathBuf,
    pub config_path: PathBuf,
    pub executable: PathBuf,
    pub config: Value,
}
impl Fixture {
    pub fn new(label: &str) -> Self {
        let root = new_directory(label);
        let executable = root.join(if cfg!(windows) {
            "假 ADB.exe"
        } else {
            "假 ADB"
        });
        fs::copy(tool_binary(), &executable).unwrap();
        let config_path = root.join("部署配置.json");
        let config = json!({"format_version":1,"tools":{"adb":executable}});
        fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        Self {
            root,
            config_path,
            executable,
            config,
        }
    }
    pub fn save_config(&self) {
        fs::write(&self.config_path, serde_json::to_vec(&self.config).unwrap()).unwrap();
    }
    pub fn plan(&self, index: usize, stdout: &[u8], stderr: &[u8], code: i32) {
        fs::write(self.root.join(format!("stdout-{index}")), stdout).unwrap();
        fs::write(self.root.join(format!("stderr-{index}")), stderr).unwrap();
        fs::write(self.root.join(format!("code-{index}")), code.to_string()).unwrap();
    }
    pub fn request(&self, operation: &str, input: Value) -> Value {
        // 模拟真实宿主Some空ArtifactContext，output_directory有值同样不应拒绝。
        json!({"protocol_version":4,"request_id":format!("independent-{operation}"),"operation":operation,
            "input":input,"artifacts":{"inputs":[],"output_directory":self.root.join("unused-output")}})
    }
    pub fn begin(&self, operation: &str, input: Value) -> Invocation {
        self.begin_request(self.request(operation, input))
    }
    pub fn begin_request(&self, request: Value) -> Invocation {
        Invocation::spawn(&self.config_path, &self.root, request, true)
    }
    pub fn begin_bad_request(&self, request: Value) -> Invocation {
        Invocation::spawn(&self.config_path, &self.root, request, false)
    }
    pub fn wait_tool(&self, index: usize) -> PidProbe {
        let call = self.root.join(format!("call-{index:02}"));
        let deadline = Instant::now() + Duration::from_secs(8);
        while !call.join("ready").exists() {
            assert!(
                Instant::now() < deadline,
                "本次工具没有到达ready，{}",
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
    pub fn release(&self, index: usize) {
        // 先完整写入再原子发布，假工具不得看到创建后尚未写入的空门闩。
        let temporary = self.root.join(format!("release-{index}.tmp"));
        fs::write(&temporary, b"1").unwrap();
        fs::rename(temporary, self.root.join(format!("release-{index}"))).unwrap();
    }
    pub fn argv(&self, index: usize) -> Vec<String> {
        let bytes = fs::read(self.root.join(format!("call-{index:02}/argv.bin"))).unwrap();
        let mut cursor = 0;
        let integer = |cursor: &mut usize| {
            let value = u32::from_le_bytes(bytes[*cursor..*cursor + 4].try_into().unwrap());
            *cursor += 4;
            value as usize
        };
        let count = integer(&mut cursor);
        assert!(count <= 32);
        let mut args = Vec::new();
        for _ in 0..count {
            let length = integer(&mut cursor);
            assert!(length <= 8192);
            args.push(String::from_utf8(bytes[cursor..cursor + length].to_vec()).unwrap());
            cursor += length;
        }
        assert_eq!(cursor, bytes.len());
        args
    }
    pub fn assert_calls(&self, expected: usize) {
        let calls = fs::read_dir(&self.root)
            .unwrap()
            .map(|item| item.unwrap())
            .filter(|item| item.file_name().to_string_lossy().starts_with("call-"))
            .count();
        assert_eq!(calls, expected, "实际进程调用数，不以输出成功代替启动证据");
    }
    pub fn assert_no_tool(&self) {
        self.assert_calls(0);
    }
    pub fn run(&self, operation: &str, input: Value, outputs: &[&[u8]]) -> Value {
        for (index, output) in outputs.iter().enumerate() {
            self.plan(index + 1, output, b"", 0);
        }
        let mut running = self.begin(operation, input);
        running.start(Duration::from_secs(20));
        for index in 1..=outputs.len() {
            let probe = self.wait_tool(index);
            self.release(index);
            probe.assert_exited();
        }
        let reply = running.complete();
        self.assert_calls(outputs.len());
        reply
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // 成功和失败均保留原帧、argv及PID证据；由主代理统一管理，不删除目录。
        eprintln!("安卓设备独立黑盒证据保留：{}", self.root.display());
    }
}

pub fn expected_device(
    id: &str,
    raw: &str,
    state: &str,
    model: Option<&str>,
    reason: Option<&str>,
) -> Value {
    let capabilities: Vec<Value> = [
        "packages",
        "app.start",
        "app.stop",
        "app.uninstall",
        "input",
    ]
    .into_iter()
    .map(|id| {
        let mut value = json!({"id":id,"version":1,"available":reason.is_none()});
        if let Some(reason) = reason {
            value["reason"] = json!(reason);
        }
        value
    })
    .collect();
    let mut value = json!({"id":id,"state":state,"raw_state":raw,"capabilities":capabilities});
    if let Some(model) = model {
        value["model"] = json!(model);
    }
    value
}
