//! 明确目标的只读活动投影；复用命令容量与回执，不建立另一份历史或执行器。

use super::{
    validation::{self, error},
    *,
};

fn same_target(left: &DebugTarget, right: &DebugTarget) -> bool {
    left.target_kind == right.target_kind
        && left.instance_id == right.instance_id
        && left.plugin_id == right.plugin_id
        && left.generation == right.generation
}

impl DebuggerService {
    pub fn activity(&self, query: ActivityQuery) -> Result<ActivityPage> {
        validation::identifier(&query.session_id)?;
        if query.limit == 0
            || query.limit > 50
            || query.before == Some(0)
            || query
                .before
                .is_some_and(|before| before > 9_007_199_254_740_991)
        {
            return Err(error(
                ErrorCode::InvalidInput,
                "活动页必须为1到50条，游标必须是有效正序号",
            ));
        }
        if let Some(id) = &query.command_id {
            validation::identifier(id)?;
        }
        if query.command_id.is_some() && query.before.is_some() {
            return Err(error(ErrorCode::InvalidInput, "活动详情不接受分页游标"));
        }
        self.with_state(|state, _, _| {
            let target = state
                .sessions
                .get(&query.session_id)
                .map(|entry| entry.value.target.clone())
                .ok_or_else(|| error(ErrorCode::NotFound, "观察会话不存在或历史已淘汰"))?;
            let mut commands: Vec<_> = state
                .commands
                .values()
                .filter(|entry| same_target(&entry.target, &target))
                .filter(|entry| {
                    query
                        .before
                        .is_none_or(|before| entry.activity_sequence < before)
                })
                .filter(|entry| {
                    query
                        .command_id
                        .as_ref()
                        .is_none_or(|id| &entry.result.command_id == id)
                })
                .collect();
            commands.sort_unstable_by_key(|entry| std::cmp::Reverse(entry.activity_sequence));
            if query.command_id.is_some() && commands.is_empty() {
                return Err(error(ErrorCode::NotFound, "当前目标没有该命令或历史已淘汰"));
            }
            let has_more = commands.len() > query.limit;
            let items: Vec<_> = commands
                .into_iter()
                .take(query.limit)
                .map(|entry| {
                    let response = if query.command_id.is_some() {
                        if let Some(value) = &entry.result.response {
                            // 回执入库时已校验，此处复用同一规则防止详情投影放大数据预算。
                            validation::response_for(entry.tool, value)?;
                        }
                        entry.result.response.clone()
                    } else {
                        None
                    };
                    Ok(ActivityItem {
                        sequence: entry.activity_sequence,
                        command_id: entry.result.command_id.clone(),
                        tool: entry.tool,
                        state: entry.result.state,
                        steps: entry.activity_steps.clone(),
                        response,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let next_before = if has_more {
                items.last().map(|item| item.sequence)
            } else {
                None
            };
            Ok(ActivityPage {
                target,
                items,
                next_before,
                gap: state.activity_history_evicted,
                retained_only: true,
            })
        })
    }
}
