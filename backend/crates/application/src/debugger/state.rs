//! 所有状态转移在短内存临界区完成；访问时惰性到期，不启动扫描进程。

use super::{config::*, events::EventRing, validation::error, *};
use std::{
    collections::{BTreeMap, VecDeque},
    time::Duration,
};
use tokio::sync::oneshot;

pub(super) struct InstanceEntry {
    pub plugins: Vec<BridgePlugin>,
    pub touched: Duration,
    pub pending: VecDeque<String>,
    pub poll_slots: std::sync::Arc<tokio::sync::Semaphore>,
}

pub(super) struct SessionEntry {
    pub value: DebugSession,
    pub touched: Duration,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase {
    Ready,
    Queued,
    Delivered,
}

pub(super) struct CommandEntry {
    pub result: DebugCommandResult,
    pub target: DebugTarget,
    pub tool: DebugTool,
    pub parameters: serde_json::Value,
    pub deadline: Duration,
    pub timeout_ms: u64,
    pub phase: Phase,
    pub waiter: Option<oneshot::Sender<DebugCommandResult>>,
    pub response_bytes: usize,
}

#[derive(Default)]
pub(super) struct State {
    pub revision: u64,
    pub instances: BTreeMap<String, InstanceEntry>,
    pub sessions: BTreeMap<String, SessionEntry>,
    pub commands: BTreeMap<String, CommandEntry>,
    pub(super) session_history: VecDeque<String>,
    command_history: VecDeque<String>,
    result_bytes: usize,
    pub events: EventRing,
}

impl State {
    pub fn emit(
        &mut self,
        kind: EventKind,
        instance: Option<String>,
        session: Option<String>,
        command: Option<String>,
        session_state: Option<SessionState>,
        command_state: Option<CommandState>,
        config: &DebuggerConfig,
    ) {
        self.revision = self.revision.wrapping_add(1);
        self.events.push(
            DebugEvent {
                sequence: 0,
                kind,
                instance_id: instance,
                session_id: session,
                command_id: command,
                session_state,
                command_state,
            },
            config,
        );
    }

    pub fn active_session(&self, id: &str) -> Result<&SessionEntry> {
        let entry = self
            .sessions
            .get(id)
            .ok_or_else(|| error(ErrorCode::NotFound, "调试会话不存在或历史已淘汰"))?;
        if entry.value.state != SessionState::Active {
            return Err(error(ErrorCode::InactiveSession, "调试会话已结束"));
        }
        Ok(entry)
    }

    pub fn targets_for(&self, id: &str) -> Vec<DebugTarget> {
        self.instances
            .get(id)
            .map(|entry| {
                entry
                    .plugins
                    .iter()
                    .map(|plugin| DebugTarget {
                        target_kind: TargetKind::Browser,
                        instance_id: Some(id.into()),
                        plugin_id: plugin.plugin_id.clone(),
                        generation: plugin.generation.clone(),
                        version: plugin.version.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn resolve_target(&self, target: &DebugTarget) -> Result<DebugTarget> {
        super::validation::target(target)?;
        if target.target_kind == TargetKind::Server {
            // 真实服务器目录由边界适配器在调用前校验，本层不伪造目录。
            return Ok(target.clone());
        }
        self.targets_for(target.instance_id.as_deref().expect("已验证实例"))
            .into_iter()
            .find(|current| {
                current.plugin_id == target.plugin_id
                    && current.generation == target.generation
                    && target
                        .version
                        .as_ref()
                        .is_none_or(|version| current.version.as_ref() == Some(version))
            })
            .ok_or_else(|| error(ErrorCode::StaleTarget, "浏览器实例未登记该插件当前代际"))
    }

    pub fn status(&self, id: &str) -> Result<BridgeStatus> {
        if !self.instances.contains_key(id) {
            return Err(error(ErrorCode::NotFound, "浏览器实例不存在或已到期"));
        }
        Ok(BridgeStatus {
            instance_id: id.into(),
            targets: self.targets_for(id),
            active_sessions: self
                .sessions
                .values()
                .filter(|entry| {
                    entry.value.state == SessionState::Active
                        && entry.value.target.instance_id.as_deref() == Some(id)
                })
                .map(|entry| entry.value.clone())
                .collect(),
        })
    }

    pub fn instance(&self, id: &str, config: &DebuggerConfig) -> Result<BrowserInstance> {
        let entry = self
            .instances
            .get(id)
            .ok_or_else(|| error(ErrorCode::NotFound, "浏览器实例不存在或已到期"))?;
        Ok(BrowserInstance {
            instance_id: id.into(),
            plugins: entry.plugins.clone(),
            active_sessions: self.status(id)?.active_sessions.len(),
            idle_ttl_ms: millis(config.instance_ttl),
        })
    }

    pub fn finish_command(
        &mut self,
        id: &str,
        terminal: CommandState,
        response: Option<serde_json::Value>,
        config: &DebuggerConfig,
    ) {
        let Some(entry) = self
            .commands
            .get_mut(id)
            .filter(|entry| !entry.result.state.terminal())
        else {
            return;
        };
        entry.result.state = terminal;
        entry.response_bytes = response
            .as_ref()
            .map(|value| {
                super::validation::encoded_size(value, 1024 * 1024).expect("已验证的调试回执可编码")
            })
            .unwrap_or(0);
        self.result_bytes += entry.response_bytes;
        entry.result.response = response;
        entry.parameters = serde_json::Value::Null;
        if let Some(waiter) = entry.waiter.take() {
            let _ = waiter.send(entry.result.clone());
        }
        let instance_id = entry.target.instance_id.clone();
        let session_id = entry.result.session_id.clone();
        if let Some(instance) = instance_id
            .as_ref()
            .and_then(|id| self.instances.get_mut(id))
        {
            instance.pending.retain(|pending| pending != id);
        }
        self.command_history.push_back(id.into());
        self.emit(
            EventKind::CommandFinished,
            instance_id.clone(),
            Some(session_id),
            Some(id.into()),
            None,
            Some(terminal),
            config,
        );
        while self.command_history.len() > config.max_command_history
            || self.result_bytes > config.max_result_bytes
        {
            if let Some(expired) = self.command_history.pop_front() {
                if let Some(removed) = self.commands.remove(&expired) {
                    self.result_bytes -= removed.response_bytes;
                }
            } else {
                break;
            }
        }
        if let Some(instance_id) = instance_id {
            self.promote(&instance_id);
        }
    }

    pub fn slots(&self, instance_id: &str) -> (usize, usize) {
        let mut occupied = 0;
        let mut queued = 0;
        for command in self.commands.values().filter(|command| {
            !command.result.state.terminal()
                && command.target.instance_id.as_deref() == Some(instance_id)
        }) {
            if command.phase == Phase::Queued {
                queued += 1;
            } else {
                occupied += 1;
            }
        }
        (occupied, queued)
    }

    fn promote(&mut self, id: &str) {
        let (occupied, _) = self.slots(id);
        let mut free = 4usize.saturating_sub(occupied);
        let Some(instance) = self.instances.get(id) else {
            return;
        };
        for pending in &instance.pending {
            if free == 0 {
                break;
            }
            if let Some(command) = self
                .commands
                .get_mut(pending)
                .filter(|entry| entry.phase == Phase::Queued && !entry.result.state.terminal())
            {
                command.phase = Phase::Ready;
                free -= 1;
            }
        }
    }

    pub fn end_session(&mut self, id: &str, terminal: SessionState, config: &DebuggerConfig) {
        let Some(entry) = self
            .sessions
            .get_mut(id)
            .filter(|entry| entry.value.state == SessionState::Active)
        else {
            return;
        };
        entry.value.state = terminal;
        let instance_id = entry.value.target.instance_id.clone();
        let commands: Vec<_> = self
            .commands
            .iter()
            .filter(|(_, entry)| entry.result.session_id == id && !entry.result.state.terminal())
            .map(|(id, _)| id.clone())
            .collect();
        for command in commands {
            self.finish_command(&command, CommandState::CancelledUnconfirmed, None, config);
        }
        self.session_history.push_back(id.into());
        self.emit(
            EventKind::SessionEnded,
            instance_id,
            Some(id.into()),
            None,
            Some(terminal),
            None,
            config,
        );
        while self.session_history.len() > config.max_session_history {
            if let Some(expired) = self.session_history.pop_front() {
                self.sessions.remove(&expired);
            }
        }
    }

    pub fn remove_instance(&mut self, id: &str, config: &DebuggerConfig) {
        self.instances.remove(id);
        let sessions: Vec<_> = self
            .sessions
            .iter()
            .filter(|(_, entry)| {
                entry.value.state == SessionState::Active
                    && entry.value.target.instance_id.as_deref() == Some(id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for session in sessions {
            self.end_session(&session, SessionState::Disconnected, config);
        }
        self.emit(
            EventKind::InstanceDisconnected,
            Some(id.into()),
            None,
            None,
            None,
            None,
            config,
        );
    }

    pub fn sweep(&mut self, now: Duration, config: &DebuggerConfig) {
        let instances: Vec<_> = self
            .instances
            .iter()
            .filter(|(_, entry)| now.saturating_sub(entry.touched) >= config.instance_ttl)
            .map(|(id, _)| id.clone())
            .collect();
        for instance in instances {
            self.remove_instance(&instance, config);
        }
        let sessions: Vec<_> = self
            .sessions
            .iter()
            .filter(|(_, entry)| {
                entry.value.state == SessionState::Active
                    && now.saturating_sub(entry.touched) >= config.session_ttl
            })
            .map(|(id, _)| id.clone())
            .collect();
        for session in sessions {
            self.end_session(&session, SessionState::Expired, config);
        }
        let commands: Vec<_> = self
            .commands
            .iter()
            .filter(|(_, entry)| !entry.result.state.terminal() && now >= entry.deadline)
            .map(|(id, _)| id.clone())
            .collect();
        for command in commands {
            self.finish_command(&command, CommandState::TimedOutUnconfirmed, None, config);
        }
        // 等待 Future 被调用方丢弃后，下次访问先撤销命令，避免再领取已撤销动作。
        let abandoned: Vec<_> = self
            .commands
            .iter()
            .filter(|(_, entry)| {
                !entry.result.state.terminal()
                    && entry
                        .waiter
                        .as_ref()
                        .is_some_and(oneshot::Sender::is_closed)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for command in abandoned {
            self.finish_command(&command, CommandState::CancelledUnconfirmed, None, config);
        }
    }
}
