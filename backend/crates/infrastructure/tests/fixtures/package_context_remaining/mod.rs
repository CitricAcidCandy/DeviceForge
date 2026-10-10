pub mod samples;
// 只读复用已冻结的产物门闩与直接 PID 探测，不改上一批夹具。
#[path = "../../../../tool-process/tests/support/liveness.rs"]
mod liveness;
#[path = "../package_context/store.rs"]
pub mod store;

use apk_domain::{
    Error, ExecutionContext, Result,
    artifacts::{Artifact, ArtifactStore},
    bundles::{BuildApksRequest, BuildMode, BundleBuilder},
    reverse::PackageReverse,
    splits::{ExtractSplitsRequest, SplitPackages},
};
use apk_infrastructure::{
    artifacts::FileArtifacts,
    bundles::{AndroidBundles, BundleSigning},
    package_tools::ToolCommand,
    reverse::AndroidReverse,
    splits::AndroidSplits,
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
use tokio::task::JoinHandle;
use tokio_util::{io::ReaderStream, sync::CancellationToken};

// 墙钟只防测试卡死，不是性能证据或扩大的业务期限。
pub const WATCHDOG: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug)]
pub enum Flow {
    Build,
    Decode,
    Scan,
    Extract,
}

fn compiled_tool() -> &'static str {
    static TOOL: OnceLock<(TempDir, String)> = OnceLock::new();
    &TOOL
        .get_or_init(|| {
            let directory = tempfile::tempdir().expect("本次自包含工具编译目录");
            let output_path = directory.path().join(if cfg!(windows) {
                "remaining-tool.exe"
            } else {
                "remaining-tool"
            });
            let source = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/package_context_remaining/tool.rs");
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
            let output = command.output().expect("主代理执行测试时编译独立工具");
            assert!(
                output.status.success(),
                "自包含工具编译失败：{}",
                String::from_utf8_lossy(&output.stderr)
            );
            (
                directory,
                output_path.to_str().expect("工具路径 UTF-8").into(),
            )
        })
        .1
}

pub struct Fixture {
    pub store: Arc<ObservedStore>,
    pub bundles: Arc<AndroidBundles>,
    pub reverse: Arc<AndroidReverse>,
    pub splits: Arc<AndroidSplits>,
    pub control: PathBuf,
    // 最后保留或释放临时根，不能在自有工具仍运行时删除。
    directory: Option<TempDir>,
}

impl Fixture {
    pub async fn new(mode: &str, delays: Delays) -> Self {
        let executable = tokio::task::spawn_blocking(|| compiled_tool().to_owned())
            .await
            .expect("工具编译任务");
        let directory = tempfile::Builder::new()
            .prefix("package-context-remaining-")
            .tempdir()
            .expect("本次独立复现目录");
        let control = directory.path().join("control");
        fs::create_dir(&control).expect("独立控制根");
        fs::write(control.join("default.apks"), samples::apks(false)).unwrap();
        fs::write(control.join("universal.apks"), samples::apks(true)).unwrap();
        fs::write(control.join("base-master.apk"), samples::apk()).unwrap();
        fs::write(control.join("base-arm64.apk"), samples::configuration_apk()).unwrap();
        let template = control.join("decoded-template");
        for (name, bytes) in samples::DECODED_FILES {
            let path = template.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        fs::write(
            control.join("decoded-files.txt"),
            samples::DECODED_FILES
                .iter()
                .map(|(name, _)| *name)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let signing_path = directory.path().join("signing");
        fs::create_dir(&signing_path).unwrap();
        for name in ["keystore", "store-password", "key-password"] {
            fs::write(signing_path.join(name), b"synthetic fixture only").unwrap();
        }
        let signing = BundleSigning {
            keystore: signing_path.join("keystore"),
            alias: "remaining-fixture".into(),
            store_password_file: signing_path.join("store-password"),
            key_password_file: signing_path.join("key-password"),
        };
        let inner = Arc::new(
            FileArtifacts::open(directory.path().join("artifacts"))
                .await
                .expect("独立真实产物仓库"),
        );
        let store = ObservedStore::new(inner, delays);
        let command = ToolCommand {
            executable: executable.clone(),
            prefix: vec![mode.into(), control.to_str().unwrap().into()],
        };
        let bundles = Arc::new(AndroidBundles::new(
            store.clone(),
            Some(command.clone()),
            Some(signing),
        ));
        let reverse = Arc::new(AndroidReverse::new(store.clone(), Some(command.clone())));
        let splits = Arc::new(AndroidSplits::new(store.clone(), Some(command), executable));
        Self {
            store,
            bundles,
            reverse,
            splits,
            control,
            directory: Some(directory),
        }
    }

    pub async fn source(&self, flow: Flow) -> Artifact {
        let (name, bytes) = match flow {
            Flow::Build => ("source.aab", samples::apk()),
            Flow::Decode => ("source.apk", samples::apk()),
            Flow::Scan => ("decoded.zip", samples::decoded()),
            Flow::Extract => ("source.apks", samples::apks(false)),
        };
        fs::write(self.control.join("expected-input.bin"), &bytes).expect("独立副本字节期望");
        let path = self.control.join("source-seed.bin");
        tokio::fs::write(&path, &bytes).await.unwrap();
        let file = tokio::fs::File::open(path).await.unwrap();
        self.store
            .inner
            .put(
                name.into(),
                Box::pin(
                    ReaderStream::new(file).map_err(|error| Error::Storage(error.to_string())),
                ),
            )
            .await
            .expect("种子上传不计被测 put")
    }

    pub fn start(
        &self,
        flow: Flow,
        id: &str,
        cancel: CancellationToken,
        context: ExecutionContext,
    ) -> JoinHandle<Result<()>> {
        let bundles = self.bundles.clone();
        let reverse = self.reverse.clone();
        let splits = self.splits.clone();
        let id = id.to_owned();
        tokio::spawn(async move {
            match flow {
                Flow::Build => bundles
                    .build_with_context(
                        BuildApksRequest {
                            artifact_id: id,
                            mode: BuildMode::Default,
                        },
                        cancel,
                        context,
                    )
                    .await
                    .map(|_| ()),
                Flow::Decode => reverse
                    .decode_with_context(&id, cancel, context)
                    .await
                    .map(|_| ()),
                Flow::Scan => reverse
                    .scan_sdks_with_context(&id, samples::rules(), cancel, context)
                    .await
                    .map(|_| ()),
                Flow::Extract => splits
                    .extract_with_context(
                        ExtractSplitsRequest {
                            artifact_id: id,
                            device_spec: samples::spec(),
                        },
                        cancel,
                        context,
                    )
                    .await
                    .map(|_| ()),
            }
        })
    }

    pub fn assert_no_tool(&self) {
        for name in [
            "started.pid",
            "ready.pid",
            "argv.txt",
            "response_written",
            "exit.code",
        ] {
            assert!(
                !self.control.join(name).exists(),
                "拒绝阶段不得生成工具证据：{name}"
            );
        }
    }

    pub fn pid(&self) -> u32 {
        fs::read_to_string(self.control.join("ready.pid"))
            .expect("本次原子 ready")
            .parse()
            .expect("本次 PID 格式")
    }

    pub async fn ready(&self) -> u32 {
        paused_until("真实工具 ready", || {
            self.control.join("ready.pid").exists()
        })
        .await;
        let pid = self.pid();
        assert!(liveness::alive(pid), "ready 必须对应本次仍活的真实进程");
        pid
    }

    pub async fn assert_tool_exited(&self) {
        let pid = self.pid();
        let limit = Instant::now() + Duration::from_secs(10);
        while liveness::alive(pid) {
            assert!(Instant::now() < limit, "同一工具 PID 尚未实际退出：{pid}");
            tokio::time::sleep(Duration::from_millis(20)).await;
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
            // 只放行本次自有进程，不终止未知 PID；保留真实失败目录。
            let _ = fs::write(self.control.join("release"), b"1");
            if let Some(directory) = self.directory.take() {
                eprintln!(
                    "package_context_remaining 失败证据：{}",
                    directory.keep().display()
                );
            }
        }
    }
}

pub fn context(point: tokio::time::Instant) -> ExecutionContext {
    ExecutionContext {
        deadline: Some(point.into_std()),
    }
}

pub fn live_context() -> ExecutionContext {
    ExecutionContext {
        deadline: Some(Instant::now() + WATCHDOG),
    }
}

pub async fn paused_until(label: &str, mut done: impl FnMut() -> bool) {
    let watchdog = Instant::now() + WATCHDOG;
    while !done() {
        assert!(Instant::now() < watchdog, "墙钟防卡死看门狗到期：{label}");
        // 持续可运行的观测任务阻止真实 I/O 期间 Tokio 自动推进暂停时钟。
        tokio::task::yield_now().await;
    }
}

pub async fn join_paused<T>(task: JoinHandle<T>) -> T {
    paused_until("受控调用终态", || task.is_finished()).await;
    task.await.expect("独立被测任务不得 panic")
}

pub async fn join_live<T>(task: JoinHandle<T>) -> T {
    tokio::time::timeout(WATCHDOG, task)
        .await
        .expect("真实调用看门狗")
        .expect("独立被测任务不得 panic")
}

pub async fn entered(gate: &Arc<store::Gate>) {
    let gate = gate.clone();
    join_paused(tokio::spawn(async move { gate.wait_entered().await })).await;
}

pub async fn expire(point: tokio::time::Instant) {
    assert!(tokio::time::Instant::now() < point, "阶段尚有原预算");
    tokio::time::advance(point - tokio::time::Instant::now()).await;
    assert_eq!(tokio::time::Instant::now(), point, "数学原 D 不变");
    // 仅供 Tokio 定时器向上取整的毫秒刻度唤醒，不改变 context 或业务预算。
    tokio::time::advance(Duration::from_millis(1)).await;
}
