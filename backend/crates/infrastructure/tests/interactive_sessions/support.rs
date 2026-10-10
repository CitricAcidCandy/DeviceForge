#[path = "../device_deadline_fixtures/liveness.rs"]
pub mod liveness;

use apk_domain::{Executor, interactive::{InteractiveSession, SessionExit, SessionRequest}};
use apk_infrastructure::plugins::ProcessPlugin;
use apk_plugin_sdk::Manifest;
use serde_json::{Value, json};
use std::{future::Future, path::{Path, PathBuf}, sync::Arc, time::{Duration, Instant as WallInstant}};
use tokio::{task::JoinHandle, time::Instant};
use tokio_util::sync::CancellationToken;

pub const BUDGET: Duration = Duration::from_secs(30);

// 墙钟仅限定失败观察；持续yield避免暂停时钟在真实进程I/O期间自动跳时。
pub async fn observe<F: Future>(future: F, stage: &str) -> F::Output {
    let fixed = Instant::now(); let watchdog = WallInstant::now() + Duration::from_secs(15);
    tokio::pin!(future);
    loop {
        assert_eq!(Instant::now(), fixed, "真实I/O观察不能自动推进时钟：{stage}");
        assert!(WallInstant::now() < watchdog, "真实看门狗到期：{stage}");
        tokio::select! { biased; result = &mut future => return result, _ = tokio::task::yield_now() => {} }
    }
}

fn node() -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::split_paths(&std::env::var_os("PATH").expect("Node PATH"))
        .map(|root| root.join(name)).find(|path| path.is_file()).expect("真实回归需要Node")
}

pub struct Fixture { directory: Option<tempfile::TempDir>, pub plugin: Arc<ProcessPlugin> }
impl Fixture {
    pub fn new() -> Self {
        let directory = tempfile::Builder::new().prefix("interactive-process-").tempdir().unwrap();
        let manifest: Manifest = serde_json::from_value(json!({
            "id":"independent-session","version":"1","protocol_version":4,"executable":node(),
            "args":[Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/interactive_sessions/provider.mjs"),directory.path()],
            "operations":[],"sessions":{"protocol_version":5,"operations":[
                {"name":"terminal","title":"独立会话","input_schema":{"type":"object"}}
            ]}
        })).expect("公开会话-only清单");
        Self { directory:Some(directory), plugin:Arc::new(ProcessPlugin::new(manifest).expect("公开会话提供者")) }
    }
    pub fn root(&self) -> &Path { self.directory.as_ref().unwrap().path() }
    pub async fn with_outputs() -> Self {
        let directory = tempfile::Builder::new().prefix("interactive-lease-").tempdir().unwrap();
        let store = Arc::new(apk_infrastructure::artifacts::FileArtifacts::open(&directory.path().join("store")).await.unwrap());
        let manifest: Manifest = serde_json::from_value(json!({
            "id":"independent-session","version":"1","protocol_version":4,"executable":node(),
            "args":[Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/interactive_sessions/provider.mjs"),directory.path()],
            "artifacts":{"input_fields":[],"input_pointers":[],"outputs":true},"operations":[],
            "sessions":{"protocol_version":5,"operations":[{"name":"terminal","title":"独立会话","input_schema":{"type":"object"}}]}
        })).unwrap();
        Self { directory:Some(directory), plugin:Arc::new(ProcessPlugin::with_artifacts(manifest,store).unwrap()) }
    }
    pub fn marker(&self, name: &str) -> PathBuf { self.root().join(format!("{name}.json")) }
    pub async fn event(&self, name: &str) -> Value {
        observe(async {
            loop {
                match tokio::fs::read(self.marker(name)).await {
                    Ok(bytes) => return serde_json::from_slice(&bytes).expect("原子JSON标记完整"),
                    Err(error) if error.kind()==std::io::ErrorKind::NotFound => {},
                    Err(error) => panic!("标记读取失败：{error}"),
                }
                tokio::task::yield_now().await;
            }
        }, name).await
    }
    pub async fn release(&self, name: &str) { observe(tokio::fs::write(self.root().join(name), b"1"), "本次文件门闩释放").await.unwrap(); }
    pub fn launch(&self, id: &str, input: Value, deadline: Instant, cancel: CancellationToken) -> Running {
        let provider = self.plugin.session_provider().expect("显式会话提供者");
        let before = std::fs::read(self.marker("started")).ok();
        let launch = provider.open(SessionRequest { session_id:id.into(), operation:"plugin.independent-session.terminal".into(), input, deadline:deadline.into_std() }, cancel)
            .expect("纯构造Launch");
        assert_eq!(std::fs::read(self.marker("started")).ok(), before, "纯构造尚未执行进程I/O");
        Running { id:id.into(), handle:Some(launch.handle), supervisor:tokio::spawn(launch.supervisor) }
    }
    pub async fn ready(&self, running: &mut Running) -> u32 {
        observe(running.handle().ready(), "公开Ready").await.expect("会话可接收输入");
        let started = observe(async {
            loop {
                let event = self.event("start").await;
                if event["frame"]["session_id"] == running.id { break event; }
                tokio::task::yield_now().await;
            }
        }, "同一次Start原帧").await;
        let pid=pid(&started); assert!(liveness::alive(pid), "握手同一个真实PID"); pid
    }
    pub async fn assert_exited(&self, pid: u32) {
        assert!(!liveness::alive(pid), "终态返回后同一直接PID应已退出");
        assert!(!self.marker("fixture-error").exists(), "夹具没有自己失败");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let alive = std::fs::read(self.marker("started")).ok().and_then(|bytes|serde_json::from_slice::<Value>(&bytes).ok()).is_some_and(|event|liveness::alive(pid(&event)));
        if (alive || std::thread::panicking()) && let Some(directory)=self.directory.take() {
            eprintln!("保留本次会话PID/协议证据：{}",directory.keep().display());
        }
    }
}

pub struct Running { pub id:String, pub handle:Option<Box<dyn InteractiveSession>>, pub supervisor:JoinHandle<()> }
impl Running {
    pub fn handle(&mut self) -> &mut dyn InteractiveSession { self.handle.as_deref_mut().unwrap() }
    pub async fn wait(&mut self) -> Arc<SessionExit> {
        let exit=observe(self.handle().wait(),"会话缓存终态").await;
        observe(&mut self.supervisor,"真实后台监督完成").await.expect("监督不得panic"); exit
    }
}
impl Drop for Running { fn drop(&mut self) { self.handle.take(); /* 后台监督保持运行，不在失败路径丢弃资源所有者。 */ } }
pub fn pid(event:&Value)->u32 { u32::try_from(event["pid"].as_u64().expect("真实PID")).unwrap() }
