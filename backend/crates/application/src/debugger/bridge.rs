//! 浏览器命令只作有界传输；领取即移出队列，未确认结果绝不自动重放。

use super::{
    config::millis,
    state::{CommandEntry, Phase, State},
    validation::{self, error},
    *,
};
use serde_json::Value;
use std::time::Duration;
use tokio::sync::oneshot;

impl DebuggerService {
    pub fn enqueue(&self, input: DebugCommandRequest) -> Result<DebugCommandReceipt> {
        commands::validate(input.tool, &input.parameters)?;
        self.with_state(|state, now, config| admit(state, input, None, now, config))
    }

    pub async fn execute(&self, input: DebugCommandRequest) -> Result<DebugCommandResult> {
        commands::validate(input.tool, &input.parameters)?;
        let (sender, receiver) = oneshot::channel();
        let started = tokio::time::Instant::now();
        let receipt =
            self.with_state(|state, now, config| admit(state, input, Some(sender), now, config))?;
        let budget = Duration::from_millis(receipt.timeout_ms);
        match tokio::time::timeout_at(started + budget, receiver).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => Err(error(ErrorCode::Internal, "调试命令结果通道异常关闭")),
            Err(_) => {
                let outcome = self.with_state(|state, _, config| {
                    state.finish_command(
                        &receipt.command_id,
                        CommandState::TimedOutUnconfirmed,
                        None,
                        config,
                    );
                    state
                        .commands
                        .get(&receipt.command_id)
                        .map(|entry| entry.result.clone())
                        .ok_or_else(|| error(ErrorCode::NotFound, "调试命令历史已淘汰"))
                });
                match outcome {
                    Err(failure)
                        if matches!(failure.code, ErrorCode::Capacity | ErrorCode::NotFound) =>
                    {
                        Ok(DebugCommandResult {
                            command_id: receipt.command_id,
                            session_id: receipt.session_id,
                            state: CommandState::TimedOutUnconfirmed,
                            response: None,
                        })
                    }
                    other => other,
                }
            }
        }
    }

    pub fn command_result(&self, command_id: &str) -> Result<DebugCommandResult> {
        self.with_state(|state, _, _| {
            state
                .commands
                .get(command_id)
                .map(|entry| entry.result.clone())
                .ok_or_else(|| error(ErrorCode::NotFound, "调试命令不存在或历史已淘汰"))
        })
    }

    pub async fn poll(&self, input: BridgePoll) -> Result<BridgeBatch> {
        validation::instance_id(&input.instance_id)?;
        if input.limit == 0 || input.limit > 4 {
            return Err(error(
                ErrorCode::InvalidInput,
                "单次桥接领取必须为 1 到 4 条",
            ));
        }
        let slots = self.with_state(|state, _, _| {
            state
                .instances
                .get(&input.instance_id)
                .map(|instance| instance.poll_slots.clone())
                .ok_or_else(|| error(ErrorCode::NotFound, "浏览器实例不存在或已到期"))
        })?;
        let _permit = slots
            .try_acquire_owned()
            .map_err(|_| error(ErrorCode::Capacity, "单实例最多同时等待 4 个桥接轮询"))?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            // 先登记通知，再检查状态，避免入队发生在检查与等待之间时丢唤醒。
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let (batch, remaining) = self.poll_batch(&input)?;
            if !batch.commands.is_empty()
                || batch.active_sessions.is_empty()
                || tokio::time::Instant::now() >= deadline
            {
                return Ok(batch);
            }
            let wake = deadline.min(tokio::time::Instant::now() + remaining);
            tokio::select! {
                _ = notified => {},
                _ = tokio::time::sleep_until(wake) => {},
            }
        }
    }

    fn poll_batch(&self, input: &BridgePoll) -> Result<(BridgeBatch, Duration)> {
        self.with_state(|state, now, config| {
            let status = state.status(&input.instance_id)?;
            state
                .instances
                .get_mut(&input.instance_id)
                .expect("已验证实例")
                .touched = now;
            let selected: Vec<_> = state
                .instances
                .get(&input.instance_id)
                .expect("已验证实例")
                .pending
                .iter()
                .filter(|id| {
                    state.commands.get(*id).is_some_and(|entry| {
                        entry.phase == Phase::Ready && !entry.result.state.terminal()
                    })
                })
                .take(input.limit)
                .cloned()
                .collect();
            let mut commands = Vec::with_capacity(selected.len());
            for id in selected {
                let entry = state.commands.get_mut(&id).expect("命令仍在锁内");
                entry.phase = Phase::Delivered;
                entry.result.state = CommandState::Delivered;
                let session_id = entry.result.session_id.clone();
                commands.push(BridgeCommand {
                    command_id: id.clone(),
                    session_id: session_id.clone(),
                    target: entry.target.clone(),
                    tool: entry.tool,
                    parameters: entry.parameters.clone(),
                    remaining_ms: millis(entry.deadline.saturating_sub(now)),
                });
                // 已交付参数不再在宿主保留；回执与历史只需要标识和有限结果。
                entry.parameters = serde_json::Value::Null;
                state
                    .instances
                    .get_mut(&input.instance_id)
                    .expect("已验证实例")
                    .pending
                    .retain(|pending| pending != &id);
                state.emit(
                    EventKind::CommandDelivered,
                    Some(input.instance_id.clone()),
                    Some(session_id),
                    Some(id),
                    None,
                    Some(CommandState::Delivered),
                    config,
                );
            }
            let remaining = state
                .sessions
                .values()
                .filter(|entry| {
                    entry.value.state == SessionState::Active
                        && entry.value.target.instance_id.as_deref()
                            == Some(input.instance_id.as_str())
                })
                .map(|entry| {
                    entry
                        .touched
                        .saturating_add(config.session_ttl)
                        .saturating_sub(now)
                })
                .chain(
                    state
                        .commands
                        .values()
                        .filter(|entry| {
                            !entry.result.state.terminal()
                                && entry.target.instance_id.as_deref()
                                    == Some(input.instance_id.as_str())
                        })
                        .map(|entry| entry.deadline.saturating_sub(now)),
                )
                .min()
                .unwrap_or(Duration::from_secs(2))
                .min(Duration::from_secs(2));
            Ok((
                BridgeBatch {
                    instance_id: status.instance_id,
                    active_sessions: status.active_sessions,
                    targets: status.targets,
                    commands,
                },
                remaining,
            ))
        })
    }

    pub fn acknowledge(&self, input: BridgeAck) -> Result<DebugCommandReceipt> {
        validation::instance_id(&input.instance_id)?;
        // 大正文校验留在锁外；数据投影按原命令工具识别，不信任回执自报种类。
        let tool = self.with_state(|state, _, _| {
            state
                .commands
                .get(&input.command_id)
                .map(|command| command.tool)
                .ok_or_else(|| error(ErrorCode::NotFound, "调试命令不存在或历史已淘汰"))
        })?;
        validation::response_for(tool, &input.response)?;
        self.with_state(|state, _, config| {
            let command = state
                .commands
                .get(&input.command_id)
                .ok_or_else(|| error(ErrorCode::NotFound, "调试命令不存在或历史已淘汰"))?;
            if command.target.instance_id.as_deref() != Some(input.instance_id.as_str()) {
                return Err(error(ErrorCode::WrongInstance, "回执不属于该浏览器实例"));
            }
            if command.target.plugin_id != input.plugin_id
                || command.target.generation != input.generation
            {
                return Err(error(ErrorCode::StaleTarget, "回执插件或代际与命令不一致"));
            }
            match command.result.state {
                CommandState::Succeeded | CommandState::Failed => {
                    return Err(error(
                        ErrorCode::DuplicateReceipt,
                        "命令回执已确认，不能重复确认",
                    ));
                }
                CommandState::TimedOutUnconfirmed | CommandState::CancelledUnconfirmed => {
                    return Err(error(
                        ErrorCode::ExpiredCommand,
                        "命令等待已结束，迟到回执不能覆盖终态",
                    ));
                }
                CommandState::Queued => {
                    return Err(error(ErrorCode::NotDelivered, "命令尚未由桥接领取"));
                }
                CommandState::Delivered => {}
            }
            let reloading = command.tool == DebugTool::Reload;
            if reloading && input.success {
                let next = input.response.get("generation").and_then(Value::as_str);
                if input.response.get("plugin_id").and_then(Value::as_str)
                    != Some(command.target.plugin_id.as_str())
                    || next.is_none()
                    || next == command.target.generation.as_deref()
                    || input.response.get("status").and_then(Value::as_str) != Some("loaded")
                {
                    return Err(error(
                        ErrorCode::StaleTarget,
                        "重载成功回执必须声明同一插件的新代次",
                    ));
                }
                validation::identifier(next.expect("已检查新代次"))?;
            } else if !reloading {
                state.resolve_target(&command.target)?;
            }
            let session = state.active_session(&command.result.session_id)?;
            if session.value.target != command.target {
                return Err(error(
                    ErrorCode::StaleTarget,
                    "会话已选择其他目标，旧结果不能进入新目标",
                ));
            }
            let receipt = DebugCommandReceipt {
                command_id: input.command_id.clone(),
                session_id: command.result.session_id.clone(),
                state: if input.success {
                    CommandState::Succeeded
                } else {
                    CommandState::Failed
                },
                timeout_ms: command.timeout_ms,
            };
            state.finish_command(
                &input.command_id,
                receipt.state,
                Some(input.response),
                config,
            );
            if reloading {
                // 此回执只证明本次重载；新代次仍须真实目录确认后再显式跟随。
                state.end_session(&receipt.session_id, SessionState::TargetChanged, config);
            }
            Ok(receipt)
        })
    }
}

fn admit(
    state: &mut State,
    input: DebugCommandRequest,
    waiter: Option<oneshot::Sender<DebugCommandResult>>,
    now: Duration,
    config: &DebuggerConfig,
) -> Result<DebugCommandReceipt> {
    let session = state.active_session(&input.session_id)?.value.clone();
    if session.target.target_kind != TargetKind::Browser {
        return Err(error(
            ErrorCode::UnsupportedTarget,
            "服务器调试由适配器调用原用例，浏览器桥接不执行服务器命令",
        ));
    }
    let target = state.resolve_target(&session.target)?;
    if input.tool == DebugTool::Reload
        && state.commands.values().any(|command| {
            command.target == target
                && command.tool == DebugTool::Reload
                && !command.result.state.terminal()
        })
    {
        return Err(error(
            ErrorCode::Capacity,
            "当前目标已有重载等待，不能重复派发",
        ));
    }
    let instance_id = target.instance_id.as_deref().expect("浏览器目标存在实例");
    let (occupied, queued) = state.slots(instance_id);
    if occupied >= 4 && queued >= 32 {
        return Err(error(
            ErrorCode::Capacity,
            "单浏览器最多 4 条在途与 32 条排队命令",
        ));
    }
    let budget = if input.tool == DebugTool::AutomationRun {
        config.automation_timeout
    } else if input.tool == DebugTool::Reload {
        config.reload_timeout
    } else if input.tool.is_action() {
        config.action_timeout
    } else {
        config.read_timeout
    };
    let deadline = now
        .checked_add(budget)
        .ok_or_else(|| error(ErrorCode::InvalidInput, "调试时钟超出支持范围"))?;
    let id = uuid::Uuid::new_v4().to_string();
    let receipt = DebugCommandReceipt {
        command_id: id.clone(),
        session_id: session.session_id.clone(),
        state: CommandState::Queued,
        timeout_ms: millis(budget),
    };
    // 仅保留有限展示元数据，参数在交付后仍按原规则释放。
    let activity_steps = if input.tool == DebugTool::AutomationRun {
        let plan: AutomationInput = serde_json::from_value(input.parameters.clone())
            .map_err(|_| error(ErrorCode::InvalidInput, "自动步骤展示信息不符合模式"))?;
        plan.steps
            .into_iter()
            .map(|step| ActivityStep {
                id: step.id,
                tool: step.tool,
                label: step.label,
            })
            .collect()
    } else {
        Vec::new()
    };
    state.activity_sequence = state
        .activity_sequence
        .checked_add(1)
        .filter(|sequence| *sequence <= 9_007_199_254_740_991)
        .ok_or_else(|| error(ErrorCode::Capacity, "调试命令序号已到上限"))?;
    state.commands.insert(
        id.clone(),
        CommandEntry {
            activity_sequence: state.activity_sequence,
            activity_steps,
            result: DebugCommandResult {
                command_id: id.clone(),
                session_id: session.session_id.clone(),
                state: CommandState::Queued,
                response: None,
            },
            target: target.clone(),
            tool: input.tool,
            parameters: input.parameters,
            deadline,
            timeout_ms: millis(budget),
            phase: if occupied < 4 {
                Phase::Ready
            } else {
                Phase::Queued
            },
            waiter,
            response_bytes: 0,
        },
    );
    state
        .sessions
        .get_mut(&session.session_id)
        .expect("已验证活动会话")
        .touched = now;
    state
        .instances
        .get_mut(instance_id)
        .expect("已验证实例")
        .pending
        .push_back(id.clone());
    state.emit(
        EventKind::CommandQueued,
        target.instance_id,
        Some(session.session_id),
        Some(id),
        None,
        Some(CommandState::Queued),
        config,
    );
    Ok(receipt)
}
