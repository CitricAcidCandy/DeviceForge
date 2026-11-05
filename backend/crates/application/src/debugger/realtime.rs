//! 实时连接只取得现有调试状态的当前代归属；断线不重放、恢复不续期。

use super::{
    state::{InstanceEntry, RealtimeTransport, State},
    validation::{self, error},
    *,
};
use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

// 线上的总上限为 1 MiB + 16 KiB；额外预留日志封套和 Socket.IO 帧头空间。
pub(super) const BATCH_BODY_BYTES: usize = 1024 * 1024 + 8 * 1024;

pub(super) fn owned(state: &State, lease: &BridgeLease) -> Result<()> {
    let transport = state
        .instances
        .get(&lease.instance_id)
        .and_then(|entry| entry.transport.as_ref())
        .ok_or_else(|| error(ErrorCode::NotFound, "实时浏览器实例不存在或恢复窗口已结束"))?;
    if transport.owner != lease.owner
        || transport.generation != lease.generation
        || transport.disconnected_at.is_some()
        || !transport.online.load(Ordering::Acquire)
    {
        return Err(error(
            ErrorCode::WrongInstance,
            "调试消息来自已撤销的连接代次",
        ));
    }
    Ok(())
}

impl DebuggerService {
    pub fn realtime_open(
        &self,
        owner: &str,
        input: BridgeOpen,
    ) -> Result<(BridgeLease, BridgeOpened)> {
        validation::identifier(owner)?;
        validation::plugins(&input.plugins)?;
        if input.inflight.len() > 4 || input.instance_id.is_some() != input.resume_key.is_some() {
            return Err(error(
                ErrorCode::InvalidInput,
                "恢复必须同时提供实例和密钥，在途命令最多 4 条",
            ));
        }
        for id in &input.inflight {
            validation::identifier(id)?;
        }
        if let Some(id) = &input.instance_id {
            validation::instance_id(id)?;
        }
        if input.resume_key.as_ref().is_some_and(|key| key.len() > 128) {
            return Err(error(ErrorCode::InvalidInput, "恢复密钥长度无效"));
        }
        self.with_state(|state, now, config| {
            let existing_owner = state
                .instances
                .iter()
                .find(|(_, entry)| {
                    entry.transport.as_ref().is_some_and(|transport| {
                        transport.owner == owner
                            && transport.disconnected_at.is_none()
                            && transport.online.load(Ordering::Acquire)
                    })
                })
                .map(|(id, _)| id.clone());
            let id = match input.instance_id.as_ref().or(existing_owner.as_ref()) {
                Some(id) => {
                    let transport = state
                        .instances
                        .get(id)
                        .and_then(|entry| entry.transport.as_ref())
                        .ok_or_else(|| {
                            error(ErrorCode::NotFound, "浏览器实例不存在或恢复窗口已结束")
                        })?;
                    if input.instance_id.is_some()
                        && input.resume_key.as_deref() != Some(transport.resume_key.as_str())
                    {
                        return Err(error(ErrorCode::WrongInstance, "浏览器恢复密钥无效"));
                    }
                    id.clone()
                }
                None => {
                    if !input.inflight.is_empty() {
                        return Err(error(
                            ErrorCode::InvalidInput,
                            "新实例不能继承旧实例的在途动作",
                        ));
                    }
                    if state.instances.len() >= config.max_instances {
                        return Err(error(ErrorCode::Capacity, "浏览器调试实例容量已满"));
                    }
                    let id = uuid::Uuid::new_v4().to_string();
                    state.instances.insert(
                        id.clone(),
                        InstanceEntry {
                            plugins: vec![],
                            touched: now,
                            pending: VecDeque::new(),
                            poll_slots: Arc::new(tokio::sync::Semaphore::new(4)),
                            transport: Some(RealtimeTransport {
                                owner: owner.into(),
                                generation: 0,
                                resume_key: uuid::Uuid::new_v4().to_string(),
                                disconnected_at: None,
                                online: Arc::new(AtomicBool::new(true)),
                            }),
                        },
                    );
                    state.emit(
                        EventKind::InstanceRegistered,
                        Some(id.clone()),
                        None,
                        None,
                        None,
                        None,
                        config,
                    );
                    id
                }
            };
            // 在修改归属和目录之前核对整份恢复清单，错误请求不能留下半次恢复。
            let inflight = input
                .inflight
                .iter()
                .map(|command_id| {
                    let command = state
                        .commands
                        .get(command_id)
                        .ok_or_else(|| error(ErrorCode::NotFound, "在途命令不存在或历史已淘汰"))?;
                    if command.target.instance_id.as_deref() != Some(id.as_str()) {
                        return Err(error(ErrorCode::WrongInstance, "在途命令不属于恢复实例"));
                    }
                    Ok((
                        command.result.command_id.clone(),
                        command.result.session_id.clone(),
                        command.result.state,
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            let entry = state
                .instances
                .get_mut(&id)
                .ok_or_else(|| error(ErrorCode::NotFound, "恢复实例已失效"))?;
            let transport = entry
                .transport
                .as_mut()
                .ok_or_else(|| error(ErrorCode::WrongInstance, "HTTP 实例不支持实时恢复"))?;
            // 同一连接重复登记保持代次；跨连接恢复撤销旧代，防止迟到清理影响新连接。
            if transport.owner != owner || transport.disconnected_at.is_some() {
                transport.online.store(false, Ordering::Release);
                transport.online = Arc::new(AtomicBool::new(true));
                transport.generation = transport.generation.wrapping_add(1);
            }
            transport.owner = owner.into();
            transport.disconnected_at = None;
            entry.touched = now;
            let resume_key = transport.resume_key.clone();
            let lease = BridgeLease {
                instance_id: id.clone(),
                owner: owner.into(),
                generation: transport.generation,
                online: transport.online.clone(),
            };
            sessions::update_plugins(state, &id, input.plugins, config)?;
            // 目录换代可能刚终结旧代命令；摘要必须在目录更新后读取，不能返回旧的 Delivered。
            let commands = inflight
                .into_iter()
                .map(|(command_id, session_id, previous)| {
                    let current = state
                        .commands
                        .get(&command_id)
                        .map(|command| command.result.state)
                        .unwrap_or_else(|| {
                            // 此临界区仅目录撤销会新终结命令；极小历史容量可能已淘汰刚取消的记录。
                            if previous.terminal() {
                                previous
                            } else {
                                CommandState::CancelledUnconfirmed
                            }
                        });
                    DebugCommandResult {
                        command_id,
                        session_id,
                        state: current,
                        response: None,
                    }
                })
                .collect();
            state.revision = state.revision.wrapping_add(1);
            Ok((
                lease,
                BridgeOpened {
                    instance_id: id.clone(),
                    resume_key,
                    status: state.status(&id)?,
                    commands,
                },
            ))
        })
    }

    pub fn realtime_directory(
        &self,
        lease: &BridgeLease,
        input: BridgeDirectory,
    ) -> Result<BridgeStatus> {
        validation::plugins(&input.plugins)?;
        self.with_state(|state, _, config| {
            owned(state, lease)?;
            same_instance(lease, &input.instance_id)?;
            sessions::update_plugins(state, &input.instance_id, input.plugins, config)?;
            state.status(&input.instance_id)
        })
    }

    pub fn realtime_status(&self, lease: &BridgeLease) -> Result<BridgeStatus> {
        self.with_state(|state, _, _| {
            owned(state, lease)?;
            state.status(&lease.instance_id)
        })
    }

    pub fn realtime_batch(
        &self,
        lease: &BridgeLease,
        limit: usize,
    ) -> Result<(BridgeBatch, Duration)> {
        if limit > 4 {
            return Err(error(ErrorCode::InvalidInput, "实时空槽数必须为 0 到 4"));
        }
        self.poll_batch(
            &BridgePoll {
                instance_id: lease.instance_id.clone(),
                limit,
            },
            Some(lease),
        )
    }

    pub fn realtime_acknowledge(
        &self,
        lease: &BridgeLease,
        input: BridgeAck,
    ) -> Result<DebugCommandReceipt> {
        same_instance(lease, &input.instance_id)?;
        self.acknowledge_inner(input, Some(lease))
    }

    pub fn realtime_detach(&self, lease: &BridgeLease) -> Result<()> {
        lease.online.store(false, Ordering::Release);
        self.with_state(|state, now, _| {
            if let Some(transport) = state
                .instances
                .get_mut(&lease.instance_id)
                .and_then(|entry| entry.transport.as_mut())
                && transport.owner == lease.owner
                && transport.generation == lease.generation
            {
                transport.disconnected_at.get_or_insert(now);
                state.revision = state.revision.wrapping_add(1);
            }
            Ok(())
        })
    }

    pub fn realtime_close(&self, lease: &BridgeLease, instance_id: &str) -> Result<()> {
        self.with_state(|state, _, config| {
            owned(state, lease)?;
            same_instance(lease, instance_id)?;
            lease.online.store(false, Ordering::Release);
            state.remove_instance(instance_id, config);
            Ok(())
        })
    }

    /// 调用者先 enable 通知再读状态，随后只按状态变化或原期限唤醒。
    pub fn realtime_changed(&self) -> tokio::sync::futures::Notified<'_> {
        self.changed.notified()
    }

    /// 竞争方先登记再尝试取锁；只在 Busy 分支等待，不启动定时扫描。
    pub fn realtime_unlocked(&self) -> tokio::sync::futures::Notified<'_> {
        self.unlocked.notified()
    }
}

fn same_instance(lease: &BridgeLease, instance_id: &str) -> Result<()> {
    if lease.instance_id != instance_id {
        return Err(error(ErrorCode::WrongInstance, "消息不属于当前实时实例"));
    }
    Ok(())
}
