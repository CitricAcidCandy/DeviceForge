//! 构造真实 Node 提供者，记录本次调用证据并验证直接进程与临时副本。

use super::{liveness, store::ControlledStore};
use apk_domain::{
    ExecutionContext, Result,
    artifacts::{Artifact, ArtifactStore},
};
use apk_infrastructure::{artifacts::FileArtifacts, plugins::ProcessPlugin};
use apk_plugin_sdk::Manifest;
use futures_util::stream;
use serde_json::{Value, json};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};

pub const OPERATION: &str = "plugin.deadlines.copy";
pub const WATCHDOG: Duration = Duration::from_secs(3);

pub fn node() -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::split_paths(&std::env::var_os("PATH").expect("真实回归需要 Node PATH"))
        .map(|root| root.join(name))
        .find(|path| path.is_file())
        .expect("真实回归需要 Node")
}

pub fn declaration(protocol: u32, api: u32, timeout: Option<Value>, marker: &Path) -> Value {
    let mut value = json!({
        "id":"deadlines", "version":"1", "protocol_version":protocol,
        "executable":node(), "args":[Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/device_deadline_fixtures/provider.cjs"), marker],
        "artifacts":{"input_pointers":["/input/artifact_id"], "outputs":true},
        "operations":[
            {"name":"discover","title":"发现期限测试设备","input_schema":{"type":"object","additionalProperties":false}},
            {"name":"copy","title":"模拟设备副本","input_schema":{"type":"object","properties":{
                "device_id":{"type":"string"}, "input":{"type":"object"}
            },"required":["device_id","input"],"additionalProperties":false}}
        ],
        "devices":{"api_version":api,"platform":"synthetic_demo","discover_operation":"discover","capabilities":[
            {"id":"device.copy","version":1,"operation":"copy","scope":"device","access":"write"}
        ]}
    });
    if let Some(timeout) = timeout {
        value["devices"]["capabilities"][0]["execution_timeout_ms"] = timeout;
    }
    value
}

pub struct Fixture {
    directory: Option<tempfile::TempDir>,
    pub marker: PathBuf,
    pub store: Arc<ControlledStore>,
    pub source: Artifact,
    pub plugin: Arc<ProcessPlugin>,
    pub protocol: u32,
}

impl Fixture {
    pub async fn new(protocol: u32, copy_blocked: bool, publish_blocked: bool) -> Self {
        Self::with_device_api(protocol, 2, copy_blocked, publish_blocked).await
    }

    pub async fn with_device_api(
        protocol: u32,
        api: u32,
        copy_blocked: bool,
        publish_blocked: bool,
    ) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("markers");
        tokio::fs::create_dir(&marker).await.unwrap();
        let inner = Arc::new(
            FileArtifacts::open(&directory.path().join("store"))
                .await
                .unwrap(),
        );
        let bytes = include_bytes!("../../src/device_artifacts/fixtures/pixel.png").to_vec();
        let source = inner
            .put(
                "source.png".into(),
                Box::pin(stream::once(async move { Ok(bytes.into()) })),
            )
            .await
            .unwrap();
        let store = ControlledStore::new(inner, copy_blocked, publish_blocked);
        let manifest: Manifest =
            serde_json::from_value(declaration(protocol, api, Some(json!(120000)), &marker))
                .unwrap();
        let plugin = Arc::new(ProcessPlugin::with_artifacts(manifest, store.clone()).unwrap());
        Self {
            directory: Some(directory),
            marker,
            store,
            source,
            plugin,
            protocol,
        }
    }

    pub fn input(&self, mode: &str) -> Value {
        json!({"device_id":"same","input":{"artifact_id":self.source.id,"mode":mode}})
    }

    pub async fn event(&self, name: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if let Ok(bytes) = tokio::fs::read(self.marker.join(format!("{name}.json"))).await
                    && let Ok(value) = serde_json::from_slice(&bytes)
                {
                    return value;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("本次夹具缺少 {name} 标记：{}", self.marker.display()))
    }

    pub async fn ready(&self) -> Value {
        let ready = self.event("ready").await;
        assert!(liveness::alive(pid(&ready)), "就绪标记必须对应真实运行进程");
        ready
    }

    pub async fn event_without_timer(&self, name: &str) -> Value {
        // 必须与 until_paused 配对；暂停时钟下不能睡眠后再检查真实文件。
        loop {
            if let Ok(bytes) = tokio::fs::read(self.marker.join(format!("{name}.json"))).await
                && let Ok(value) = serde_json::from_slice(&bytes)
            {
                return value;
            }
            tokio::task::yield_now().await;
        }
    }

    pub fn assert_not_started(&self) {
        assert!(
            !self.marker.join("started.json").exists(),
            "过期或预取消不得启动进程"
        );
    }

    pub async fn assert_cleaned(&self, ready: &Value) {
        assert!(
            !liveness::alive(pid(ready)),
            "调用返回时直接子进程必须已退出"
        );
        let work = PathBuf::from(ready["work"].as_str().unwrap());
        let copy = ready["copy"].as_str().map(PathBuf::from);
        tokio::time::timeout(Duration::from_secs(5), async {
            while work.exists()
                || copy
                    .as_ref()
                    .is_some_and(|path| path.parent().unwrap().exists())
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("本次工作目录与副本目录必须清理");
        assert!(
            self.store.inner.get(&self.source.id).await.is_ok(),
            "不得删除源产物"
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let alive = std::fs::read(self.marker.join("started.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|event| liveness::alive(pid(&event)));
        // 失败时保留本次证据；不杀进程，也不触碰其它测试或用户目录。
        if (std::thread::panicking() || alive)
            && let Some(directory) = self.directory.take()
        {
            eprintln!("本次期限夹具证据保留：{}", directory.keep().display());
        }
    }
}

pub fn pid(event: &Value) -> u32 {
    u32::try_from(event["pid"].as_u64().expect("夹具 PID")).unwrap()
}

pub fn context(deadline: Instant) -> ExecutionContext {
    ExecutionContext {
        deadline: Some(deadline),
    }
}

pub async fn until<F, T>(call: Pin<&mut F>, stage: impl Future<Output = T>) -> T
where
    F: Future<Output = Result<Value>>,
{
    tokio::select! {
        result = call => panic!("未到达预期阶段调用已经结束：{result:?}"),
        value = stage => value,
    }
}

pub async fn until_paused<F, T>(
    mut call: Pin<&mut F>,
    stage: impl Future<Output = T>,
    stage_name: &str,
) -> T
where
    F: Future<Output = Result<Value>>,
{
    let paused_at = tokio::time::Instant::now();
    let observed_until = Instant::now() + Duration::from_secs(12);
    tokio::pin!(stage);
    loop {
        // 持续保持可运行 Future，避免真实 I/O 等待让 Tokio 自动跳到业务期限。
        tokio::select! {
            biased;
            result = call.as_mut() => panic!("暂停时钟阶段 {stage_name} 前调用结束：{result:?}"),
            value = stage.as_mut() => {
                assert_eq!(tokio::time::Instant::now(), paused_at, "到达 {stage_name} 时暂停时钟不得自动推进");
                return value;
            },
            _ = tokio::task::yield_now() => {}
        }
        assert_eq!(
            tokio::time::Instant::now(),
            paused_at,
            "等待 {stage_name} 时暂停时钟不得自动推进"
        );
        // 墙钟只界定阶段观察失败，不参与业务预算或生产清理期限。
        assert!(
            Instant::now() < observed_until,
            "真实 I/O 未在观察上限内到达 {stage_name}"
        );
    }
}

pub async fn finish(call: impl Future<Output = Result<Value>>, deadline: Instant) -> Result<Value> {
    // 仅为测试失败设置外层观察上限；不是业务期限，不改变生产清理宽限。
    tokio::time::timeout_at(tokio::time::Instant::from_std(deadline + WATCHDOG), call)
        .await
        .expect("调用没有按原绝对期限及独立清理预算收敛")
}

pub async fn wait_exited(pid: u32) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while liveness::alive(pid) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("丢弃执行 Future 后本次直接 PID 应退出");
}
