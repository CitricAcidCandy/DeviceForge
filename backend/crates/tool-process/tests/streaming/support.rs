#[path = "../support/liveness.rs"]
pub mod liveness;

use deviceforge_tool_process::{ExecutionOptions, OutputStream, StreamOptions, StreamingProcess};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tempfile::TempDir;
use tokio::time::{Instant, sleep, timeout};

pub const RUN_BUDGET: Duration = Duration::from_secs(60);
pub const READY_BUDGET: Duration = Duration::from_secs(15);
pub const EXIT_BUDGET: Duration = Duration::from_secs(10);

pub fn fixture() -> &'static str {
    static EXECUTABLE: OnceLock<String> = OnceLock::new();
    EXECUTABLE.get_or_init(|| {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间")
            .as_nanos();
        let root = option_env!("CARGO_TARGET_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let directory = root.join(format!(
            "tool-process-streaming-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("独占夹具编译目录");
        let executable = directory.join(if cfg!(windows) {
            "streaming.exe"
        } else {
            "streaming"
        });
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/streaming.rs");
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
        let output = compiler.output().expect("运行独立夹具编译器");
        assert!(
            output.status.success(),
            "夹具编译失败：{}",
            String::from_utf8_lossy(&output.stderr)
        );
        executable.to_str().expect("夹具路径 UTF-8").to_owned()
    })
}

pub fn options() -> StreamOptions {
    StreamOptions::new(ExecutionOptions::new(Instant::now() + RUN_BUDGET))
}

pub struct Case {
    directory: Option<TempDir>,
}
impl Case {
    pub fn new() -> Self {
        Self {
            directory: Some(
                tempfile::Builder::new()
                    .prefix("tool-process-stream-case-")
                    .tempdir()
                    .expect("本次专属目录"),
            ),
        }
    }
    pub fn path(&self) -> &Path {
        self.directory.as_ref().expect("用例持有目录").path()
    }
    pub fn ready(&self) -> PathBuf {
        self.path().join("ready.pid")
    }
    pub fn release(&self) -> PathBuf {
        self.path().join("release")
    }
    pub fn args(&self, mode: &str) -> Vec<String> {
        vec![mode.into(), self.ready().to_str().expect("标记路径").into()]
    }
    pub async fn publish_release(&self) {
        tokio::fs::write(self.release(), b"1")
            .await
            .expect("释放本次夹具");
    }
    pub fn flood_args(&self, stdout: usize, stderr: usize) -> Vec<String> {
        let mut args = self.args("flood");
        args.extend([
            stdout.to_string(),
            stderr.to_string(),
            self.release().to_str().unwrap().into(),
        ]);
        args
    }
}
impl Drop for Case {
    fn drop(&mut self) {
        if let Ok(text) = fs::read_to_string(self.ready())
            && let Ok(pid) = text.parse::<u32>()
            && liveness::alive(pid)
        {
            let directory = self.directory.take().expect("持有用例目录").keep();
            eprintln!("直接 PID {pid} 尚存，保留本次目录：{}", directory.display());
        }
    }
}

pub async fn ready(path: &Path) -> u32 {
    let end = Instant::now() + READY_BUDGET;
    loop {
        match tokio::fs::read_to_string(path).await {
            Ok(text) => {
                let pid = text.parse().expect("原子标记包含完整 PID");
                assert!(liveness::alive(pid), "就绪时真实 PID 存在");
                return pid;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("就绪标记读取失败：{error}"),
        }
        assert!(Instant::now() < end, "夹具未在宽松预算内就绪");
        sleep(Duration::from_millis(25)).await;
    }
}

pub fn assert_exited(pid: u32) {
    assert!(!liveness::alive(pid), "返回后直接 PID {pid} 仍存在");
}
pub async fn wait_exited(pid: u32) {
    let end = Instant::now() + EXIT_BUDGET;
    while liveness::alive(pid) {
        assert!(Instant::now() < end, "直接 PID {pid} 未及时退出");
        sleep(Duration::from_millis(25)).await;
    }
}

pub async fn receive_until(
    process: &mut StreamingProcess,
    stdout: &mut Vec<u8>,
    stderr: &mut Vec<u8>,
    minimum: usize,
) {
    timeout(READY_BUDGET, async {
        while stdout.len() < minimum || stderr.len() < minimum {
            let chunk = process
                .recv()
                .await
                .expect("预期原字节输出，流不得提前关闭");
            assert!(!chunk.bytes.is_empty(), "数据块必须携带字节");
            match chunk.stream {
                OutputStream::Stdout => stdout.extend(chunk.bytes),
                OutputStream::Stderr => stderr.extend(chunk.bytes),
            }
        }
    })
    .await
    .expect("持续输出必须在宽松预算内可见");
}
