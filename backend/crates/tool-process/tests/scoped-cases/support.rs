use super::os::ProcessObservation;
use deviceforge_tool_process::{ExecutionOptions, StreamOptions, ToolCommand};
use serde_json::{Value, json};
use std::os::windows::process::CommandExt;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::{Instant, sleep};

pub const READY_BUDGET: Duration = Duration::from_secs(10);
pub const EXIT_BUDGET: Duration = Duration::from_secs(3);

fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(0x0800_0000);
    command
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("实际工程根")
}

fn nonce() -> String {
    let value = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("系统时间")
        .as_nanos();
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        (value >> 96) as u32,
        (value >> 80) as u16,
        (value >> 64) as u16,
        (value >> 48) as u16,
        value & 0xffff_ffff_ffff
    )
}

pub fn fixture() -> &'static str {
    static BINARY: OnceLock<String> = OnceLock::new();
    BINARY.get_or_init(|| {
        let directory = root()
            .join("artifacts")
            .join("scoped-process-fixtures-".to_owned() + &nonce());
        fs::create_dir_all(&directory).expect("编译本轮独立夹具目录");
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scoped-fixtures");
        for entry in fs::read_dir(&source).expect("原生夹具源码") {
            let entry = entry.expect("源码成员");
            if entry.path().extension().is_some_and(|value| value == "rs") {
                fs::copy(entry.path(), directory.join(entry.file_name())).expect("冻结夹具源码");
            }
        }
        let executable = directory.join("scoped-tool.exe");
        let output = hidden_command("rustc")
            .args(["--edition=2024", "-D", "warnings"])
            .arg(directory.join("main.rs"))
            .arg("-o")
            .arg(&executable)
            .output()
            .expect("标准库夹具编译");
        fs::write(directory.join("compile.stdout"), &output.stdout).expect("编译标准输出");
        fs::write(directory.join("compile.stderr"), &output.stderr).expect("编译错误输出");
        assert!(
            output.status.success(),
            "原生夹具编译失败：{}",
            String::from_utf8_lossy(&output.stderr)
        );
        executable.to_str().expect("实际程序UTF-8路径").to_owned()
    })
}

pub fn options() -> StreamOptions {
    StreamOptions::new(ExecutionOptions::new(
        Instant::now() + Duration::from_secs(20),
    ))
}

pub struct Probe {
    pub role: String,
    pub prefix: PathBuf,
    pub child: Child,
}

pub struct Case {
    pub directory: PathBuf,
    pub args: Vec<String>,
    pub identities: Vec<Value>,
    pub observations: Arc<Mutex<Vec<ProcessObservation>>>,
    pub probes: Vec<Probe>,
    pub report: Value,
    pub completed: bool,
}

impl Case {
    pub fn new(name: &str, pipe: &str, scenario: &str, root_code: u8, delay_ms: u64) -> Self {
        let nonce = nonce();
        let directory = root()
            .join("artifacts")
            .join(format!("scoped-api-{name}-{nonce}"));
        fs::create_dir_all(&directory).expect("独占真实API用例目录");
        fs::write(directory.join("owner"), &nonce).expect("本轮身份");
        let args = vec![
            "--evidence".into(),
            directory.to_str().expect("实际目录UTF-8").into(),
            "--nonce".into(),
            nonce.clone(),
            "--role".into(),
            "root".into(),
            "--scenario".into(),
            scenario.into(),
            "--pipe".into(),
            pipe.into(),
            "--root-exit-code".into(),
            root_code.to_string(),
            "--delay-ms".into(),
            delay_ms.to_string(),
            "--parent-pid".into(),
            std::process::id().to_string(),
        ];
        Self {
            directory,
            args,
            identities: Vec::new(),
            observations: Arc::new(Mutex::new(Vec::new())),
            probes: Vec::new(),
            report: json!({"name":name,"nonce":nonce,"public_scope_verified":false,
                "peripheral_cleanup_used":false}),
            completed: false,
        }
    }

    pub async fn read_json(&self, name: &str) -> Value {
        let deadline = Instant::now() + READY_BUDGET;
        loop {
            match fs::read(self.directory.join(name)) {
                Ok(bytes) => match serde_json::from_slice(&bytes) {
                    Ok(value) => return value,
                    Err(error) if error.is_eof() && Instant::now() < deadline => {
                        sleep(Duration::from_millis(10)).await
                    }
                    Err(error) => panic!("原生证据{name}不是有效JSON：{error}"),
                },
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        && Instant::now() < deadline =>
                {
                    sleep(Duration::from_millis(10)).await
                }
                Err(error) => panic!("读取原生证据{name}失败：{error}"),
            }
        }
    }

    #[allow(dead_code)]
    pub async fn ready(&mut self, roles: &[&str]) {
        for role in roles {
            let value = self.read_json(&format!("ready-{role}.json")).await;
            assert_eq!(value["role"], *role);
            assert_eq!(value["nonce"], self.report["nonce"]);
            let pid = u32::try_from(value["pid"].as_u64().expect("真实PID")).expect("PID范围");
            let observation = ProcessObservation::new(
                pid,
                value["creation_time_100ns"].as_str().expect("创建身份"),
                role,
                fixture(),
            );
            self.observations.lock().expect("观察锁").push(observation);
            self.identities.push(value);
        }
        for index in 1..self.identities.len() {
            let target = &self.identities[index];
            let parent = &self.identities[index - 1];
            assert_eq!(target["parent_pid"], parent["pid"]);
            assert_eq!(parent["children"], json!([target["pid"]]));
            let role = target["role"].as_str().expect("角色").to_owned();
            let prefix = self.directory.join(format!("probe-{role}"));
            let binary = root().join(
                "artifacts/harmony-screenshot-fixtures-20261012/process-probe-observable.exe",
            );
            let stdout = fs::File::create(prefix.with_extension("stdout")).expect("探针输出");
            let stderr = fs::File::create(prefix.with_extension("stderr")).expect("探针错误输出");
            let child = hidden_command(binary)
                .args([
                    "--pid",
                    &target["pid"].to_string(),
                    "--evidence",
                    prefix.to_str().expect("证据UTF-8"),
                    "--parent-pid",
                    &parent["pid"].to_string(),
                    "--expected-parent",
                    fixture(),
                ])
                .stdin(Stdio::null())
                .stdout(stdout)
                .stderr(stderr)
                .spawn()
                .expect("真实OS探针");
            self.probes.push(Probe {
                role,
                prefix: prefix.clone(),
                child,
            });
            let ready = self
                .read_json(
                    prefix
                        .with_extension("ready.json")
                        .file_name()
                        .expect("探针ready文件")
                        .to_str()
                        .expect("文件UTF-8"),
                )
                .await;
            for (actual, expected) in [(&ready["target"], target), (&ready["parent"], parent)] {
                assert_eq!(actual["pid"], expected["pid"]);
                assert_eq!(
                    actual["creation_time_100ns"],
                    expected["creation_time_100ns"]
                );
                assert_eq!(actual["state"], "running");
            }
            assert_eq!(ready["parent_pid_checked"], true);
            assert_eq!(ready["parent_path_checked"], true);
        }
        self.report["identities"] = json!(self.identities);
    }

    pub fn release(&self, role: &str) {
        let pending = self.directory.join(format!("release-{role}.pending"));
        fs::write(&pending, b"1").expect("写独立门闩");
        fs::rename(pending, self.directory.join(format!("release-{role}")))
            .expect("原子发布独立门闩");
    }

    pub fn command(&self) -> ToolCommand<'_> {
        let arguments = self.args.clone();
        let leaked = Box::leak(arguments.into_boxed_slice());
        ToolCommand::new(fixture(), leaked)
    }

    pub async fn api_ready_root(&mut self) -> Value {
        let value = self.read_json("ready-root.json").await;
        assert_eq!(value["role"], "root");
        assert_eq!(value["nonce"], self.report["nonce"]);
        let pid = u32::try_from(value["pid"].as_u64().expect("真实PID")).expect("PID范围");
        self.observations
            .lock()
            .expect("观察锁")
            .push(ProcessObservation::new(
                pid,
                value["creation_time_100ns"].as_str().expect("创建身份"),
                "root",
                fixture(),
            ));
        self.identities.push(value.clone());
        self.report["identities"] = json!(self.identities);
        value
    }

    pub async fn api_ready(&mut self) {
        let roles = ["root", "child", "grandchild"];
        for role in roles {
            let value = self.read_json(&format!("ready-{role}.json")).await;
            assert_eq!(value["role"], role);
            assert_eq!(value["nonce"], self.report["nonce"]);
            let pid = u32::try_from(value["pid"].as_u64().expect("真实PID")).expect("PID范围");
            self.observations
                .lock()
                .expect("观察锁")
                .push(ProcessObservation::new(
                    pid,
                    value["creation_time_100ns"].as_str().expect("创建身份"),
                    role,
                    fixture(),
                ));
            self.identities.push(value);
        }
        for index in 1..roles.len() {
            let target = &self.identities[index];
            let parent = &self.identities[index - 1];
            assert_eq!(target["parent_pid"], parent["pid"]);
            assert_eq!(parent["children"], json!([target["pid"]]));
            let role = target["role"].as_str().expect("角色").to_owned();
            let prefix = self.directory.join(format!("probe-{role}"));
            let binary = root().join(
                "artifacts/harmony-screenshot-fixtures-20261012/process-probe-observable.exe",
            );
            let stdout = fs::File::create(prefix.with_extension("stdout")).expect("探针输出");
            let stderr = fs::File::create(prefix.with_extension("stderr")).expect("探针错误输出");
            let child = hidden_command(binary)
                .args([
                    "--pid",
                    &target["pid"].to_string(),
                    "--evidence",
                    prefix.to_str().expect("证据UTF-8"),
                    "--parent-pid",
                    &parent["pid"].to_string(),
                    "--expected-parent",
                    fixture(),
                ])
                .stdin(Stdio::null())
                .stdout(stdout)
                .stderr(stderr)
                .spawn()
                .expect("真实OS探针");
            self.probes.push(Probe {
                role,
                prefix: prefix.clone(),
                child,
            });
            let ready = self
                .read_json(
                    prefix
                        .with_extension("ready.json")
                        .file_name()
                        .expect("探针ready文件")
                        .to_str()
                        .expect("文件UTF-8"),
                )
                .await;
            for (actual, expected) in [(&ready["target"], target), (&ready["parent"], parent)] {
                assert_eq!(actual["pid"], expected["pid"]);
                assert_eq!(
                    actual["creation_time_100ns"],
                    expected["creation_time_100ns"]
                );
                assert_eq!(actual["state"], "running");
            }
        }
        self.report["identities"] = json!(self.identities);
    }

    pub async fn finish(&mut self) {
        let actual_exits = {
            let actual = self.observations.lock().expect("真实句柄锁");
            assert!(!actual.is_empty());
            assert!(
                actual.iter().all(ProcessObservation::exited),
                "Complete返回时全部稳定OS句柄必须已退出"
            );
            actual
                .iter()
                .map(ProcessObservation::exit_record)
                .collect::<Vec<_>>()
        };
        self.report["actual_exits"] = json!(actual_exits);
        let deadline = Instant::now() + EXIT_BUDGET;
        for index in 0..self.probes.len() {
            loop {
                let probe = &mut self.probes[index];
                if let Some(status) = probe.child.try_wait().expect("实际探针等待") {
                    assert_eq!(status.code(), Some(0), "探针须真实退出0");
                    break;
                }
                assert!(Instant::now() < deadline, "所有探针共享原退出确认点");
                sleep(Duration::from_millis(10)).await;
            }
            let probe = &self.probes[index];
            let value: Value = serde_json::from_slice(
                &fs::read(probe.prefix.with_extension("exit.json")).expect("真实退出原件"),
            )
            .expect("探针退出JSON");
            assert_eq!(value["test_kill"], false);
            for target in ["target", "parent"] {
                assert_eq!(value[target]["state"], "exited");
                assert_eq!(value[target]["wait_status"], 0);
                let expected = self
                    .identities
                    .iter()
                    .find(|entry| entry["pid"] == value[target]["pid"])
                    .expect("本轮角色");
                assert_eq!(
                    value[target]["creation_time_100ns"],
                    expected["creation_time_100ns"]
                );
            }
            self.report[format!("probe_exit_{}", probe.role)] = value;
        }
        self.report["public_scope_verified"] = json!(true);
        self.completed = true;
        self.save();
    }

    fn save(&self) {
        fs::write(
            self.directory.join("report.json"),
            serde_json::to_vec_pretty(&self.report).expect("真实API报告JSON"),
        )
        .expect("保留真实API报告");
    }
}

impl Drop for Case {
    fn drop(&mut self) {
        if !self.completed {
            self.report["public_scope_verified"] = json!(false);
            self.report["peripheral_cleanup_used"] = json!(true);
            let records = self
                .identities
                .iter()
                .map(|value| {
                    format!(
                        "{}\t{}\t{}",
                        value["pid"],
                        value["creation_time_100ns"].as_str().unwrap_or_default(),
                        value["role"].as_str().unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            if !records.is_empty()
                && fs::write(self.directory.join("owned.tsv"), records).is_ok()
                && let Ok(output) = hidden_command(fixture())
                    .args([
                        "--evidence",
                        self.directory.to_str().unwrap_or_default(),
                        "--nonce",
                        self.report["nonce"].as_str().unwrap_or_default(),
                        "--role",
                        "recover",
                    ])
                    .output()
            {
                self.report["peripheral_cleanup_exit"] = json!(output.status.code());
                self.report["peripheral_cleanup_stderr"] =
                    json!(String::from_utf8_lossy(&output.stderr));
            }
            let deadline = std::time::Instant::now() + EXIT_BUDGET;
            for probe in &mut self.probes {
                while probe.child.try_wait().ok().flatten().is_none()
                    && std::time::Instant::now() < deadline
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            let _ = fs::write(
                self.directory.join("report.json"),
                serde_json::to_vec_pretty(&self.report).unwrap_or_default(),
            );
        }
    }
}

#[tokio::test]
async fn ready_json_oracle_waits_for_complete_bytes_and_rejects_invalid_syntax() {
    let mut case = Case::new("ready-json-oracle", "stdout", "read-only-oracle", 0, 0);
    case.report["test_oracle_only"] = json!(true);
    // 本用例不创建进程，禁止进入进程恢复分支；公有作用域证据始终保持未验证。
    case.completed = true;
    case.save();
    let name = "staged-ready.json";
    let path = case.directory.join(name);
    fs::write(&path, b"").expect("创建尚未写入的ready原件");
    {
        let reading = case.read_json(name);
        tokio::pin!(reading);
        tokio::select! {
            _ = &mut reading => panic!("空ready原件不得返回"),
            _ = sleep(Duration::from_millis(40)) => {}
        }
        fs::write(&path, br#"{"ready":"#).expect("写入尚未完成的ready原件");
        tokio::select! {
            _ = &mut reading => panic!("部分ready原件不得返回"),
            _ = sleep(Duration::from_millis(40)) => {}
        }
        let expected = json!({"ready":true,"source":"test_oracle_only"});
        fs::write(&path, serde_json::to_vec(&expected).expect("完整JSON"))
            .expect("完成同一ready原件");
        let actual = tokio::time::timeout(Duration::from_secs(1), &mut reading)
            .await
            .expect("完整原件应在原预算内返回");
        assert_eq!(actual, expected);
    }
    fs::write(case.directory.join("invalid-ready.json"), br#"{"ready": }"#)
        .expect("写入完整但语法无效的ready原件");
    let case = Arc::new(case);
    let reader_case = Arc::clone(&case);
    let mut readers = tokio::task::JoinSet::new();
    readers.spawn(async move { reader_case.read_json("invalid-ready.json").await });
    let rejection = tokio::time::timeout(Duration::from_secs(1), readers.join_next())
        .await
        .expect("非EOF语法错误必须直接拒绝")
        .expect("读取器任务必须结束")
        .expect_err("无效语法不得返回JSON");
    assert!(rejection.is_panic());
    drop(readers);
    let mut case = Arc::try_unwrap(case).unwrap_or_else(|_| panic!("读取器必须释放用例"));
    case.report["test_oracle_verified"] = json!(true);
    case.save();
}
