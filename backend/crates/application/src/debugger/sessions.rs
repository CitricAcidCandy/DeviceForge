//! 实例登记、当前目录和显式目标会话；心跳不延长会话生命。

use super::{
    config::millis,
    state::{InstanceEntry, SessionEntry},
    validation::{self, error},
    *,
};
use std::collections::VecDeque;

impl DebuggerService {
    pub fn register_instance(&self, input: BridgeRegistration) -> Result<BrowserInstance> {
        validation::plugins(&input.plugins)?;
        self.with_state(|state, now, config| {
            if state.instances.len() >= config.max_instances {
                return Err(error(ErrorCode::Capacity, "浏览器调试实例容量已满"));
            }
            let id = uuid::Uuid::new_v4().to_string();
            state.instances.insert(
                id.clone(),
                InstanceEntry {
                    plugins: input.plugins,
                    touched: now,
                    pending: VecDeque::new(),
                    poll_slots: std::sync::Arc::new(tokio::sync::Semaphore::new(4)),
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
            state.instance(&id, config)
        })
    }

    pub fn instances(&self) -> Result<Vec<BrowserInstance>> {
        self.with_state(|state, _, config| {
            state
                .instances
                .keys()
                .map(|id| state.instance(id, config))
                .collect()
        })
    }

    pub fn heartbeat(&self, input: BridgeHeartbeat) -> Result<BridgeStatus> {
        validation::instance_id(&input.instance_id)?;
        if let Some(plugins) = &input.plugins {
            validation::plugins(plugins)?;
        }
        self.with_state(|state, now, config| {
            let instance = state
                .instances
                .get_mut(&input.instance_id)
                .ok_or_else(|| error(ErrorCode::NotFound, "浏览器实例不存在或已到期"))?;
            instance.touched = now;
            if let Some(plugins) = input.plugins {
                instance.plugins = plugins;
                let obsolete: Vec<_> = state
                    .sessions
                    .iter()
                    .filter(|(_, entry)| {
                        entry.value.state == SessionState::Active
                            && entry.value.target.instance_id.as_deref()
                                == Some(input.instance_id.as_str())
                            && state.resolve_target(&entry.value.target).is_err()
                    })
                    .map(|(id, _)| id.clone())
                    .collect();
                for session in obsolete {
                    let reloading = state.commands.values().any(|command| {
                        command.result.session_id == session
                            && command.tool == DebugTool::Reload
                            && command.result.state == CommandState::Delivered
                    });
                    if reloading {
                        // 重载的卸载与加载间隙可先到心跳；只保留这次重载的回执通道。
                        let obsolete: Vec<_> = state
                            .commands
                            .iter()
                            .filter(|(_, command)| {
                                command.result.session_id == session
                                    && !(command.tool == DebugTool::Reload
                                        && command.result.state == CommandState::Delivered)
                                    && !command.result.state.terminal()
                            })
                            .map(|(id, _)| id.clone())
                            .collect();
                        for command in obsolete {
                            state.finish_command(
                                &command,
                                CommandState::CancelledUnconfirmed,
                                None,
                                config,
                            );
                        }
                    } else {
                        state.end_session(&session, SessionState::TargetChanged, config);
                    }
                }
            }
            state.status(&input.instance_id)
        })
    }

    pub fn targets(&self) -> Result<Vec<DebugTarget>> {
        self.with_state(|state, _, _| {
            Ok(state
                .instances
                .keys()
                .flat_map(|id| state.targets_for(id))
                .collect())
        })
    }

    pub fn open_session(&self, input: SessionRequest) -> Result<DebugSession> {
        self.with_state(|state, now, config| {
            let target = state.resolve_target(&input.target)?;
            if state
                .sessions
                .values()
                .filter(|entry| entry.value.state == SessionState::Active)
                .count()
                >= config.max_sessions
            {
                return Err(error(ErrorCode::Capacity, "活动调试会话容量已满"));
            }
            let session = DebugSession {
                session_id: uuid::Uuid::new_v4().to_string(),
                target,
                state: SessionState::Active,
                idle_ttl_ms: millis(config.session_ttl),
            };
            state.sessions.insert(
                session.session_id.clone(),
                SessionEntry {
                    value: session.clone(),
                    touched: now,
                },
            );
            state.emit(
                EventKind::SessionOpened,
                session.target.instance_id.clone(),
                Some(session.session_id.clone()),
                None,
                Some(SessionState::Active),
                None,
                config,
            );
            Ok(session)
        })
    }

    pub fn session(&self, id: &str) -> Result<DebugSession> {
        self.with_state(|state, _, _| {
            state
                .sessions
                .get(id)
                .map(|entry| entry.value.clone())
                .ok_or_else(|| error(ErrorCode::NotFound, "调试会话不存在或历史已淘汰"))
        })
    }

    pub fn touch_session(&self, id: &str) -> Result<DebugSession> {
        self.with_state(|state, now, _| {
            state.active_session(id)?;
            let entry = state.sessions.get_mut(id).expect("已验证活动会话");
            entry.touched = now;
            Ok(entry.value.clone())
        })
    }

    /// 只撤销明确旧代的会话；其他代次和用户新选择不受影响。
    pub fn target_changed(&self, previous: &DebugTarget) -> Result<()> {
        self.with_state(|state, _, config| {
            let obsolete: Vec<_> = state
                .sessions
                .iter()
                .filter(|(_, entry)| {
                    entry.value.state == SessionState::Active
                        && entry.value.target.target_kind == previous.target_kind
                        && entry.value.target.instance_id == previous.instance_id
                        && entry.value.target.plugin_id == previous.plugin_id
                        && entry.value.target.generation == previous.generation
                })
                .map(|(id, _)| id.clone())
                .collect();
            for session in obsolete {
                state.end_session(&session, SessionState::TargetChanged, config);
            }
            Ok(())
        })
    }

    pub fn select_target(&self, id: &str, target: DebugTarget) -> Result<DebugSession> {
        self.with_state(|state, now, config| {
            selectable(state, id, now, config)?;
            let resolved = state.resolve_target(&target)?;
            let previous = &state.sessions.get(id).expect("已验证活动会话").value.target;
            if previous != &resolved {
                let commands: Vec<_> = state
                    .commands
                    .iter()
                    .filter(|(_, command)| {
                        command.result.session_id == id && !command.result.state.terminal()
                    })
                    .map(|(id, _)| id.clone())
                    .collect();
                for command in commands {
                    state.finish_command(
                        &command,
                        CommandState::CancelledUnconfirmed,
                        None,
                        config,
                    );
                }
            }
            let entry = state.sessions.get_mut(id).expect("已验证活动会话");
            entry.value.target = resolved;
            entry.value.state = SessionState::Active;
            entry.touched = now;
            let session = entry.value.clone();
            state.session_history.retain(|previous| previous != id);
            state.emit(
                EventKind::SessionTargetSelected,
                session.target.instance_id.clone(),
                Some(id.into()),
                None,
                Some(SessionState::Active),
                None,
                config,
            );
            Ok(session)
        })
    }

    /// 只跟随本次操作捕获的旧目标；用户已切换、关闭或等待过期时不覆盖选择。
    pub fn follow_target(
        &self,
        id: &str,
        previous: &DebugTarget,
        next: DebugTarget,
    ) -> Result<Option<DebugSession>> {
        self.with_state(|state, now, config| {
            if !state.sessions.get(id).is_some_and(|entry| {
                &entry.value.target == previous
                    && matches!(
                        entry.value.state,
                        SessionState::Active | SessionState::TargetChanged
                    )
                    && now.saturating_sub(entry.touched) < config.session_ttl
            }) {
                return Ok(None);
            }
            if previous.plugin_id != next.plugin_id
                || previous.target_kind != next.target_kind
                || previous.instance_id != next.instance_id
                || previous.generation == next.generation
            {
                return Err(error(
                    ErrorCode::StaleTarget,
                    "重载跟随必须是同一实例和插件的新代次",
                ));
            }
            selectable(state, id, now, config)?;
            let resolved = state.resolve_target(&next)?;
            // 撤销旧代未完成的命令，旧回执仍保留原终态，不迁移到新代。
            state.end_session(id, SessionState::TargetChanged, config);
            let entry = state.sessions.get_mut(id).expect("已验证会话");
            entry.value.target = resolved;
            entry.value.state = SessionState::Active;
            entry.touched = now;
            let session = entry.value.clone();
            state.session_history.retain(|previous| previous != id);
            state.emit(
                EventKind::SessionTargetSelected,
                session.target.instance_id.clone(),
                Some(id.into()),
                None,
                Some(SessionState::Active),
                None,
                config,
            );
            Ok(Some(session))
        })
    }

    pub fn close_session(&self, id: &str) -> Result<DebugSession> {
        self.with_state(|state, _, config| {
            if !state.sessions.contains_key(id) {
                return Err(error(ErrorCode::NotFound, "调试会话不存在或历史已淘汰"));
            }
            state.end_session(id, SessionState::Closed, config);
            if let Some(entry) = state.sessions.get_mut(id)
                && entry.value.state == SessionState::TargetChanged
            {
                entry.value.state = SessionState::Closed;
            }
            Ok(state
                .sessions
                .get(id)
                .expect("刚关闭会话保留在有界历史中")
                .value
                .clone())
        })
    }

    pub fn disconnect(&self, instance_id: &str) -> Result<()> {
        validation::instance_id(instance_id)?;
        self.with_state(|state, _, config| {
            if !state.instances.contains_key(instance_id) {
                return Err(error(ErrorCode::NotFound, "浏览器实例不存在或已到期"));
            }
            state.remove_instance(instance_id, config);
            Ok(())
        })
    }
}

fn selectable(
    state: &super::state::State,
    id: &str,
    now: std::time::Duration,
    config: &DebuggerConfig,
) -> Result<()> {
    let entry = state
        .sessions
        .get(id)
        .ok_or_else(|| error(ErrorCode::NotFound, "调试会话不存在或历史已淘汰"))?;
    if entry.value.state == SessionState::Active {
        return Ok(());
    }
    if entry.value.state != SessionState::TargetChanged
        || now.saturating_sub(entry.touched) >= config.session_ttl
    {
        return Err(error(
            ErrorCode::InactiveSession,
            "调试会话已结束，请重新打开",
        ));
    }
    if state
        .sessions
        .values()
        .filter(|entry| entry.value.state == SessionState::Active)
        .count()
        >= config.max_sessions
    {
        return Err(error(ErrorCode::Capacity, "活动调试会话容量已满"));
    }
    Ok(())
}
