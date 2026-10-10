pub mod samples;
pub mod store;
// 只读复用本次 PID 存在性探测，不复用被测生产实现或发送终止信号。
#[path = "../../../../tool-process/tests/support/liveness.rs"]
mod liveness;

use apk_domain::{
    Error, ExecutionContext, Result,
    artifacts::{Artifact, ArtifactStore},
    packages::PackageAnalyzer,
};
use apk_infrastructure::{
    artifacts::FileArtifacts,
    package_tools::{AndroidPackageTools, ToolCommand},
};
use futures_util::TryStreamExt;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use store::{Delays, ObservedStore};
use tempfile::TempDir;
use tokio::{task::JoinHandle, time::sleep};
use tokio_util::{io::ReaderStream, sync::CancellationToken};

// 看门狗只防卡死，不是业务限额、性能或生产清理窗口。
pub const WATCHDOG: Duration = Duration::from_secs(30);
pub const TOOL_BUDGET: Duration = Duration::from_secs(8);

#[derive(Clone, Copy, Debug)]
pub enum Flow {
    Manifest,
    Signature,
    Extract,
}

pub const FLOWS: [Flow; 3] = [Flow::Manifest, Flow::Signature, Flow::Extract];

fn compiled_tool() -> &'static str {
    static TOOL: OnceLock<(TempDir, String)> = OnceLock::new();
    &TOOL
        .get_or_init(|| {
            let directory = tempfile::tempdir().expect("本次编译夹具目录");
            let output_path = directory.path().join(if cfg!(windows) {
                "context-tool.exe"
            } else {
                "context-tool"
            });
            let source = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/package_context/tool.rs");
            let mut command = Command::new("rustc");
            command
                .arg("--edition=2024")
                .arg(source)
                .arg("-o")
                .arg(&output_path);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000);
            }
            let output = command.output().expect("主代理运行测试时编译自包含夹具");
            assert!(
                output.status.success(),
                "夹具编译失败：{}",
                String::from_utf8_lossy(&output.stderr)
            );
            (
                directory,
                output_path.to_str().expect("夹具路径 UTF-8").into(),
            )
        })
        .1
}

pub struct Fixture {
    pub store: Arc<ObservedStore>,
    pub tools: Arc<AndroidPackageTools>,
    pub control: PathBuf,
    executable: String,
    // 最后释放临时目录，先关闭 FileArtifacts 锁和工具配置引用。
    directory: Option<TempDir>,
}

impl Fixture {
    pub async fn new(delays: Delays) -> Self {
        let executable = tokio::task::spawn_blocking(|| compiled_tool().to_owned())
            .await
            .expect("编译夹具任务");
        let directory = tempfile::Builder::new()
            .prefix("package-context-")
            .tempdir()
            .expect("独立测试目录");
        let control = directory.path().join("control");
        fs::create_dir(&control).expect("本次控制目录");
        fs::write(control.join("manifest.txt"), samples::MANIFEST).expect("独立清单样本");
        fs::write(control.join("signature.txt"), samples::SIGNATURE).expect("独立签名样本");
        let inner = Arc::new(
            FileArtifacts::open(directory.path().join("artifacts"))
                .await
                .expect("独立产物仓库"),
        );
        let store = ObservedStore::new(inner, delays);
        let tools = Arc::new(AndroidPackageTools::new(
            store.clone(),
            command(&executable, &control, "response", "manifest.txt"),
            command(&executable, &control, "response", "signature.txt"),
            Some(command(&executable, &control, "response", "manifest.txt")),
        ));
        Self {
            store,
            tools,
            control,
            executable,
            directory: Some(directory),
        }
    }

    pub fn set_tool_mode(&mut self, mode: &str) {
        self.tools = Arc::new(AndroidPackageTools::new(
            self.store.clone(),
            command(&self.executable, &self.control, mode, "manifest.txt"),
            command(&self.executable, &self.control, mode, "signature.txt"),
            Some(command(
                &self.executable,
                &self.control,
                mode,
                "manifest.txt",
            )),
        ));
    }

    pub fn manifest_text(&self, text: &str) {
        fs::write(self.control.join("manifest.txt"), text).expect("本次独立 XML");
    }

    pub fn signature_text(&self, text: &str) {
        fs::write(self.control.join("signature.txt"), text).expect("本次独立报告");
    }

    pub async fn upload(&self, filename: &str, bytes: &[u8]) -> Artifact {
        let file = tempfile::NamedTempFile::new().expect("本次种子文件");
        tokio::fs::write(file.path(), bytes)
            .await
            .expect("写独立输入");
        let file = tokio::fs::File::open(file.path())
            .await
            .expect("读独立输入");
        self.store
            .inner
            .put(
                filename.into(),
                Box::pin(ReaderStream::new(file).map_err(|e| Error::Storage(e.to_string()))),
            )
            .await
            .expect("上传合法种子；不计入被测 put")
    }

    pub async fn source(&self, flow: Flow) -> Artifact {
        match flow {
            Flow::Manifest | Flow::Signature => self.upload("sample.apk", &samples::apk()).await,
            Flow::Extract => self.upload("source.apks", &samples::apks()).await,
        }
    }

    pub fn start(
        &self,
        flow: Flow,
        id: &str,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> JoinHandle<Result<()>> {
        let tools = self.tools.clone();
        let id = id.to_owned();
        tokio::spawn(async move {
            match flow {
                Flow::Manifest => tools
                    .manifest_with_context(&id, None, cancel, context)
                    .await
                    .map(|_| ()),
                Flow::Signature => tools
                    .signature_with_context(&id, cancel, context)
                    .await
                    .map(|_| ()),
                Flow::Extract => tools
                    .extract_apk_with_context(&id, samples::ENTRY, cancel, context)
                    .await
                    .map(|_| ()),
            }
        })
    }

    pub fn assert_no_tool(&self) {
        assert!(
            !self.control.join("started.pid").exists(),
            "拒绝阶段不应进入真实工具 main"
        );
        assert!(
            !self.control.join("ready.pid").exists(),
            "拒绝阶段不应启动真实工具"
        );
        assert!(
            !self.control.join("argv.txt").exists(),
            "拒绝阶段不应记录实际 argv"
        );
    }

    pub async fn ready(&self) -> u32 {
        paused_until("真实工具 ready", || {
            self.control.join("ready.pid").exists()
        })
        .await;
        let pid = fs::read_to_string(self.control.join("ready.pid"))
            .expect("完整原子 ready PID")
            .parse()
            .expect("ready PID 格式");
        assert!(liveness::alive(pid), "ready 必须对应真实存活的本次进程");
        pid
    }

    pub fn pid(&self) -> u32 {
        fs::read_to_string(self.control.join("ready.pid"))
            .expect("工具已实际 ready")
            .parse()
            .expect("本次 PID 格式")
    }

    pub async fn assert_tool_exited(&self) {
        let pid = self.pid();
        let limit = Instant::now() + Duration::from_secs(10);
        while liveness::alive(pid) {
            assert!(Instant::now() < limit, "本次工具 PID 未实际退出：{pid}");
            sleep(Duration::from_millis(20)).await;
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let live = fs::read_to_string(self.control.join("started.pid"))
            .ok()
            .and_then(|text| text.parse().ok())
            .is_some_and(liveness::alive);
        if std::thread::panicking() || live {
            // 只通知本次自有工具门闩；不发送进程终止信号，保留失败复现根。
            let _ = fs::write(self.control.join("release"), b"1");
            if let Some(directory) = self.directory.take() {
                eprintln!(
                    "本次 package_context 证据保留：{}",
                    directory.keep().display()
                );
            }
        }
    }
}

fn command(executable: &str, control: &Path, mode: &str, response: &str) -> ToolCommand {
    ToolCommand {
        executable: executable.into(),
        prefix: vec![
            mode.into(),
            control.to_str().expect("控制路径 UTF-8").into(),
            response.into(),
        ],
    }
}

pub fn context(point: tokio::time::Instant) -> ExecutionContext {
    ExecutionContext {
        deadline: Some(point.into_std()),
    }
}

pub async fn paused_until(label: &str, mut done: impl FnMut() -> bool) {
    let watchdog = Instant::now() + WATCHDOG;
    while !done() {
        assert!(Instant::now() < watchdog, "墙钟看门狗到期：{label}");
        // 持续可运行的观测器防止真实 I/O 期间 Tokio 暂停时钟自动跳到 D。
        tokio::task::yield_now().await;
    }
}

pub async fn join_paused<T>(task: JoinHandle<T>) -> T {
    paused_until("受控调用终态", || task.is_finished()).await;
    task.await.expect("被测任务不得 panic")
}

pub async fn join_live<T>(task: JoinHandle<T>) -> T {
    tokio::time::timeout(WATCHDOG, task)
        .await
        .expect("真实调用看门狗")
        .expect("被测任务不得 panic")
}

pub async fn expire(point: tokio::time::Instant) {
    assert!(tokio::time::Instant::now() < point, "阶段尚有原预算");
    tokio::time::advance(point - tokio::time::Instant::now()).await;
    assert_eq!(tokio::time::Instant::now(), point, "数学原截止点不变");
    // 仅供定时器毫秒刻度唤醒；不重算 context 或扩大被测预算。
    tokio::time::advance(Duration::from_millis(1)).await;
}
