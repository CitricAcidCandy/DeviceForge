mod entry;
mod input;
mod output_cache;
mod supervision;

use crate::Application;
use apk_domain::{Error, Result, interactive::*};
use deviceforge_observability::LogContext;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

pub(crate) const RECORD_LIMIT: usize = 8;
pub(crate) const ACTIVE_LIMIT: usize = 4;
pub(crate) const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
pub(crate) const MESSAGE_LIMIT: usize = 65536;

#[derive(Default)]
pub(crate) struct Sessions {
    entries: Mutex<BTreeMap<String, Arc<entry::Entry>>>,
}

impl Sessions {
    fn find(&self, id: &str) -> Result<Arc<entry::Entry>> {
        apk_domain::identifier(id)?;
        self.entries
            .lock()
            .map_err(|_| Error::Storage("会话记录读取异常".into()))?
            .get(id)
            .cloned()
            .ok_or_else(|| Error::NotFound("会话记录不存在".into()))
    }

    pub(crate) fn cancel_all(&self) {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for entry in entries.values() {
            entry.cancel();
        }
    }
}

impl Application {
    pub fn contributions_snapshot(
        &self,
    ) -> (u64, Vec<apk_domain::Operation>, Vec<SessionDefinition>) {
        self.registry.contributions_snapshot()
    }

    pub fn session_definitions(&self) -> (u64, Vec<SessionDefinition>) {
        self.registry.session_definitions()
    }

    pub fn session_definition(&self, operation: &str) -> Option<SessionDefinition> {
        self.registry
            .session(operation)
            .ok()
            .map(|entry| entry.definition.clone())
    }

    pub fn session_records(&self) -> Vec<SessionInfo> {
        self.sessions
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .values()
            .map(|entry| entry.snapshot())
            .collect()
    }

    pub fn open_session(self: &Arc<Self>, operation: &str, input: Value) -> Result<SessionInfo> {
        self.open_session_with_client(operation, input, None)
    }

    pub fn open_session_with_client(
        self: &Arc<Self>,
        operation: &str,
        input: Value,
        client_is_local: Option<bool>,
    ) -> Result<SessionInfo> {
        let admitted_at = tokio::time::Instant::now();
        let registered = self.registry.session(operation)?;
        registered
            .validator
            .validate(&input)
            .map_err(|_| Error::Invalid("会话打开参数不符合模式".into()))?;
        let deadline = admitted_at
            + Duration::from_millis(
                registered
                    .definition
                    .execution
                    .expect("会话注册已固化有效预算")
                    .total_timeout_ms,
            );
        let active = self
            .active
            .lock()
            .map_err(|_| Error::Storage("会话准入状态异常".into()))?;
        if !active.accepting {
            return Err(Error::Conflict("服务正在停止接收会话".into()));
        }
        if !self.registry.current_session(&registered)? {
            return Err(Error::Conflict("会话贡献已撤销或重载".into()));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(Error::Timeout);
        }
        let mut entries = self
            .sessions
            .entries
            .lock()
            .map_err(|_| Error::Storage("会话容量状态异常".into()))?;
        if entries.len() >= RECORD_LIMIT
            || entries.values().filter(|entry| !entry.finished()).count() >= ACTIVE_LIMIT
        {
            return Err(Error::Conflict(
                "会话容量已满，请停止或删除已结束会话".into(),
            ));
        }
        let owner_info = registered.owner.info();
        let info = SessionInfo {
            id: uuid::Uuid::new_v4().to_string(),
            operation: operation.into(),
            plugin_id: owner_info.id,
            generation: owner_info.generation,
            status: SessionStatus::Opening,
            created_at: apk_domain::now(),
            output_sequence: 0,
            completion: None,
        };
        let cancel = registered.owner.cancel.child_token();
        let recovery_input = input.clone();
        let launch = registered.provider.open(
            SessionRequest {
                session_id: info.id.clone(),
                operation: operation.into(),
                input,
                client: client_is_local.map(|is_local| SessionClient {
                    id: info.id.clone(),
                    is_local,
                }),
                deadline: deadline.into_std(),
            },
            cancel.clone(),
        )?;
        let entry = Arc::new(entry::Entry::new(
            info.clone(),
            launch.handle.input(),
            cancel,
            deadline,
            registered.definition.output_retention,
        ));
        let (done, completed) = tokio::sync::watch::channel(false);
        let supervisor_owner = registered.owner.clone();
        let supervisor_entry = entry.clone();
        let supervisor_token = supervisor_owner.tracker.token();
        let consumer_owner = registered.owner.clone();
        let consumer_entry = entry.clone();
        let consumer_token = consumer_owner.tracker.token();
        let recovery_app = self.clone();
        let recovery_owner = consumer_owner.clone();
        let start = tokio_util::sync::CancellationToken::new();
        let supervisor_start = start.clone();
        let consumer_start = start.clone();
        entries.insert(info.id.clone(), entry);
        self.tracker.spawn(LogContext::propagate(async move {
            let _owner = supervisor_token;
            supervisor_start.cancelled().await;
            supervision::supervise(launch.supervisor, supervisor_entry, supervisor_owner, done)
                .await;
        }));
        self.tracker.spawn(LogContext::propagate(async move {
            consumer_start.cancelled().await;
            supervision::consume(launch.handle, consumer_entry, consumer_owner, completed).await;
            drop(consumer_token);
            // 仅在本次真实监督结束并释放owner凭据后做一次恢复，不重放会话。
            tokio::task::yield_now().await;
            recovery_app
                .auto_recover_finished_session(recovery_owner, recovery_input)
                .await;
        }));
        drop(entries);
        drop(active);
        tracing::info!(session_id = %info.id, operation = %info.operation,
            plugin_id = %info.plugin_id, generation = %info.generation, "交互会话已准入");
        start.cancel();
        Ok(info)
    }

    pub fn session(&self, id: &str) -> Result<SessionInfo> {
        Ok(self.sessions.find(id)?.snapshot())
    }

    pub fn session_output(&self, id: &str, after: u64, limit: usize) -> Result<SessionOutputPage> {
        if !(1..=100).contains(&limit) {
            return Err(Error::Invalid("会话输出页长必须在1至100之间".into()));
        }
        self.sessions.find(id)?.output(after, limit)
    }

    pub async fn session_send(&self, id: &str, bytes: &[u8]) -> Result<()> {
        self.sessions.find(id)?.admit(Some(bytes)).await
    }

    pub async fn session_eof(&self, id: &str) -> Result<()> {
        self.sessions.find(id)?.admit(None).await
    }

    pub fn session_cancel(&self, id: &str) -> Result<SessionInfo> {
        let entry = self.sessions.find(id)?;
        entry.cancel();
        Ok(entry.snapshot())
    }

    pub fn session_release(self: &Arc<Self>, id: &str) -> Result<SessionInfo> {
        let entry = self.sessions.find(id)?;
        let info = entry.snapshot();
        if info.status == SessionStatus::Finished {
            // 释放工作台记录不等于宣称外部资源已清理；历史失败留在返回值和日志中。
            self.session_remove(id)?;
            return Ok(info);
        }
        entry.cancel();
        if entry.request_release() {
            let app = self.clone();
            let session_id = id.to_owned();
            let mut finished = entry.finished.subscribe();
            self.tracker.spawn(LogContext::propagate(async move {
                while !*finished.borrow_and_update() {
                    if finished.changed().await.is_err() {
                        return;
                    }
                }
                // 用户已明确结束本次会话，不能因历史清理失败永久占住工作台名额。
                let _ = app.session_remove(&session_id);
            }));
        }
        Ok(entry.snapshot())
    }

    pub fn session_remove(&self, id: &str) -> Result<()> {
        apk_domain::identifier(id)?;
        let mut entries = self
            .sessions
            .entries
            .lock()
            .map_err(|_| Error::Storage("会话记录删除异常".into()))?;
        let entry = entries
            .get(id)
            .ok_or_else(|| Error::NotFound("会话记录不存在".into()))?;
        if !entry.finished() {
            return Err(Error::Conflict("只能删除已结束会话".into()));
        }
        entries.remove(id);
        Ok(())
    }
}
