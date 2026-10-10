mod liveness;

use deviceforge_tool_process::{Error, ExecutionOptions, OutputStream};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tempfile::TempDir;
use tokio::time::{Instant, sleep};

pub const RUN_BUDGET: Duration = Duration::from_secs(60);
pub const READY_BUDGET: Duration = Duration::from_secs(15);
pub const EXIT_OBSERVATION: Duration = Duration::from_secs(10);

pub fn options() -> ExecutionOptions {
    ExecutionOptions::new(Instant::now() + RUN_BUDGET)
}

pub fn fixture() -> &'static str {
    static EXECUTABLE: OnceLock<String> = OnceLock::new();
    EXECUTABLE.get_or_init(|| {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间")
            .as_nanos();
        let root = option_env!("CARGO_TARGET_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let directory = root.join(format!(
            "tool-process-fixture-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("创建本次夹具编译产物目录");
        let executable = directory.join(if cfg!(windows) {
            "fixture.exe"
        } else {
            "fixture"
        });
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/process.rs");
        let mut compiler = Command::new("rustc");
        compiler
            .arg("--edition=2024")
            .arg(source)
            .arg("-o")
            .arg(&executable);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            compiler.creation_flags(0x0800_0000);
        }
        let output = compiler.output().expect("运行夹具编译器");
        assert!(
            output.status.success(),
            "夹具编译失败：{}",
            String::from_utf8_lossy(&output.stderr)
        );
        executable.to_str().expect("夹具路径使用 UTF-8").to_owned()
    })
}

pub struct Case {
    directory: Option<TempDir>,
}

impl Case {
    pub fn new() -> Self {
        Self {
            directory: Some(
                tempfile::Builder::new()
                    .prefix("tool-process-behavior-")
                    .tempdir()
                    .expect("本次临时目录"),
            ),
        }
    }

    pub fn path(&self) -> &Path {
        self.directory
            .as_ref()
            .expect("临时目录仍由本用例持有")
            .path()
    }

    pub fn ready(&self) -> PathBuf {
        self.path().join("ready.pid")
    }

    pub fn holding_args(&self, mode: &str) -> Vec<String> {
        vec![
            mode.into(),
            self.ready().to_str().expect("受控标记路径").into(),
        ]
    }
}

impl Drop for Case {
    fn drop(&mut self) {
        if let Ok(text) = fs::read_to_string(self.ready())
            && let Ok(pid) = text.parse::<u32>()
            && liveness::alive(pid)
        {
            // 失败时保留本次标记；不强杀 PID，不删除仍在使用的目录。
            let path = self.directory.take().expect("持有临时目录").keep();
            eprintln!("夹具 {pid} 仍存在，本次目录保留：{}", path.display());
        }
    }
}

pub async fn ready(path: &Path) -> u32 {
    let deadline = Instant::now() + READY_BUDGET;
    loop {
        match tokio::fs::read_to_string(path).await {
            Ok(text) => {
                let pid = text.parse().expect("就绪标记完整 PID");
                assert!(liveness::alive(pid), "就绪进程必须真实存在");
                return pid;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("读取就绪标记失败：{error}"),
        }
        assert!(Instant::now() < deadline, "夹具未在宽松就绪预算内发布标记");
        sleep(Duration::from_millis(25)).await;
    }
}

pub fn assert_exited(pid: u32) {
    assert!(!liveness::alive(pid), "返回时直接子进程仍存在：{pid}");
}

pub async fn wait_exited(pid: u32) {
    let deadline = Instant::now() + EXIT_OBSERVATION;
    while liveness::alive(pid) {
        assert!(
            Instant::now() < deadline,
            "丢弃 Future 后夹具 PID 未退出：{pid}"
        );
        sleep(Duration::from_millis(25)).await;
    }
}

pub fn assert_limit(error: Error, expected: OutputStream, expected_limit: u64) {
    match error {
        Error::OutputTooLarge { stream, limit } => {
            assert_eq!(stream, expected);
            assert_eq!(limit, expected_limit);
        }
        other => panic!("应返回精确输出限额错误，实际为：{other:?}"),
    }
}

pub fn framed(values: &[String]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for value in values {
        bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }
    bytes
}

pub fn decode(mut bytes: &[u8]) -> Vec<String> {
    let mut values = Vec::new();
    while !bytes.is_empty() {
        assert!(bytes.len() >= 4, "参数帧长度完整");
        let size = u32::from_le_bytes(bytes[..4].try_into().expect("四字节长度")) as usize;
        bytes = &bytes[4..];
        assert!(bytes.len() >= size, "参数帧内容完整");
        values.push(String::from_utf8(bytes[..size].to_vec()).expect("夹具文本帧使用 UTF-8"));
        bytes = &bytes[size..];
    }
    values
}
