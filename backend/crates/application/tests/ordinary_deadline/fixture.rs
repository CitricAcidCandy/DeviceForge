//! 仅从公开应用、插件装配和存储端口建立宿主受控用例。
use super::{
    clock::paused_until,
    executor::{ALIAS, Call, MAIN, Probe, input},
    store::Store,
};
use apk_application::{Application, operation_aliases::Config, plugin_lifecycle::PluginService};
use apk_domain::{
    Error, Job, JobStatus, Result,
    plugins::{PluginCatalog, PluginContribution},
};
use async_trait::async_trait;
use serde_json::json;
use std::{collections::HashSet, sync::Arc};
use tokio::{task::JoinHandle, time::Instant};

pub struct Fixture {
    pub app: Arc<Application>,
    pub store: Arc<Store>,
    pub probe: Arc<Probe>,
    plugins: Option<Arc<PluginService>>,
}

impl Fixture {
    pub fn new(budget: Option<u64>, concurrency: usize) -> Self {
        let store = Arc::new(Store::default());
        let probe = Probe::new(budget);
        let app = Application::new(store.clone(), vec![probe.clone()], concurrency, 16).unwrap();
        Self {
            app,
            store,
            probe,
            plugins: None,
        }
    }

    pub async fn alias(budget: Option<u64>) -> Self {
        let store = Arc::new(Store::default());
        let probe = Probe::new(budget);
        let bindings: Config = serde_json::from_value(json!({
            "format_version":1,
            "bindings":[{
                "operation":{
                    "id":ALIAS, "title":"受控旧入口", "input_schema":{
                        "type":"object", "required":["label"], "additionalProperties":false,
                        "properties":{"label":{"type":"string"}}
                    }
                },
                "target":{"kind":"operation","plugin_id":"ordinaryprobe","operation":MAIN},
                "input":"identity", "result":{"kind":"identity"}
            }]
        }))
        .unwrap();
        let app = Application::new_with_bindings(store.clone(), vec![], 1, 16, bindings).unwrap();
        let plugins = PluginService::new(
            app.clone(),
            Arc::new(Catalog(probe.clone())),
            HashSet::new(),
        );
        let service = plugins.clone();
        let executor = probe.clone();
        let loaded = tokio::spawn(async move {
            service
                .seed(PluginContribution {
                    id: "ordinaryprobe".into(),
                    version: "1.0.0".into(),
                    executor,
                })
                .await
        });
        paused_until("公开插件装配完成", || {
            loaded.is_finished().then_some(())
        })
        .await;
        loaded.await.unwrap().unwrap();
        Self {
            app,
            store,
            probe,
            plugins: Some(plugins),
        }
    }

    pub async fn submit(&self, operation: &str, label: &str) -> Job {
        let app = self.app.clone();
        let operation = operation.to_owned();
        let value = input(label);
        let submitted = tokio::spawn(async move { app.submit_async(operation, value).await });
        paused_until("异步提交完成", || {
            submitted.is_finished().then_some(())
        })
        .await;
        submitted.await.unwrap().unwrap()
    }

    pub async fn call(&self, label: &str) -> Call {
        paused_until("执行器实际首 poll", || self.probe.call(label)).await
    }

    pub async fn terminal(&self, id: &str) -> Job {
        paused_until("任务终态", || {
            let job = self.app.get(id).unwrap();
            job.status.is_terminal().then_some(job)
        })
        .await
    }

    pub async fn fill_storage(&self) -> Vec<JoinHandle<Result<Vec<Job>>>> {
        let before = self.store.listing.entered();
        self.store.listing.close();
        let waiting = (0..4)
            .map(|_| {
                let app = self.app.clone();
                tokio::spawn(async move { app.list_async(16).await })
            })
            .collect::<Vec<_>>();
        paused_until("四个真实存储工作已占槽", || {
            (self.store.listing.entered() == before + 4).then_some(())
        })
        .await;
        waiting
    }

    pub async fn drain_storage(&self, waiting: Vec<JoinHandle<Result<Vec<Job>>>>) {
        self.store.listing.release();
        paused_until("存储占槽工作结束", || {
            waiting.iter().all(JoinHandle::is_finished).then_some(())
        })
        .await;
        for task in waiting {
            task.await.unwrap().unwrap();
        }
    }

    pub async fn shutdown(&self) {
        self.store.release_all();
        self.probe.release_all();
        let app = self.app.clone();
        let plugins = self.plugins.clone();
        let stopped = tokio::spawn(async move {
            if let Some(plugins) = plugins {
                plugins.close();
                plugins.wait().await;
            }
            app.shutdown().await
        });
        paused_until("应用关闭排空", || stopped.is_finished().then_some(())).await;
        stopped.await.unwrap().unwrap();
    }

    pub fn cleanup_failed(&self) -> bool {
        self.plugins
            .as_ref()
            .unwrap()
            .list()
            .iter()
            .any(|plugin| plugin.cleanup_failed)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // 断言失败仍放行本套件持有的门闩，避免遗留阻塞线程。
        self.store.release_all();
        self.probe.release_all();
    }
}

struct Catalog(Arc<Probe>);

#[async_trait]
impl PluginCatalog for Catalog {
    async fn load(&self, id: &str) -> Result<PluginContribution> {
        if id != "ordinaryprobe" {
            return Err(Error::NotFound(id.into()));
        }
        Ok(PluginContribution {
            id: id.into(),
            version: "1.0.0".into(),
            executor: self.0.clone(),
        })
    }
}

pub fn timed_out(job: &Job) {
    assert_eq!(job.status, JobStatus::Failed);
    assert_eq!(job.error.as_deref(), Some("执行超时"));
    assert!(job.result.is_none());
}

pub fn deadline(call: &Call) -> Instant {
    call.deadline.expect("普通操作必须把同一绝对期限传入上下文")
}
