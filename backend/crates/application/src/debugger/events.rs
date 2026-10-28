//! 事件仅保存生命周期元数据，按条数和编码字节数双重限额。

use super::{config::DebuggerConfig, validation::error, *};
use std::collections::VecDeque;

#[derive(Default)]
pub(super) struct EventRing {
    entries: VecDeque<(DebugEvent, usize)>,
    bytes: usize,
    sequence: u64,
    dropped: u64,
    last_dropped: u64,
}

impl EventRing {
    pub fn push(&mut self, mut event: DebugEvent, config: &DebuggerConfig) {
        self.sequence = self.sequence.saturating_add(1);
        event.sequence = self.sequence;
        let bytes = serde_json::to_vec(&event)
            .expect("固定事件契约可编码")
            .len();
        if bytes > config.max_event_bytes {
            self.dropped = self.dropped.saturating_add(1);
            self.last_dropped = self.sequence;
            return;
        }
        while self.entries.len() >= config.max_events || self.bytes + bytes > config.max_event_bytes
        {
            if let Some((event, removed)) = self.entries.pop_front() {
                self.bytes -= removed;
                self.dropped = self.dropped.saturating_add(1);
                self.last_dropped = self.last_dropped.max(event.sequence);
            } else {
                break;
            }
        }
        self.bytes += bytes;
        self.entries.push_back((event, bytes));
    }

    pub fn page(&self, query: &EventQuery) -> Result<EventPage> {
        if query.limit == 0 || query.limit > 200 || query.after > self.sequence {
            return Err(error(
                ErrorCode::InvalidInput,
                "事件页必须为 1 到 200 条，游标不能超过最新序号",
            ));
        }
        let oldest = self
            .entries
            .front()
            .map(|(event, _)| event.sequence)
            .unwrap_or(self.sequence.saturating_add(1));
        let events: Vec<_> = self
            .entries
            .iter()
            .map(|(event, _)| event)
            .filter(|event| event.sequence > query.after)
            .filter(|event| {
                query
                    .session_id
                    .as_ref()
                    .is_none_or(|id| event.session_id.as_ref() == Some(id))
            })
            .take(query.limit)
            .cloned()
            .collect();
        let next_after = events
            .last()
            .map(|event| event.sequence)
            .unwrap_or(self.sequence.max(query.after));
        Ok(EventPage {
            events,
            next_after,
            oldest_available: oldest,
            latest_sequence: self.sequence,
            gap: query.after < self.last_dropped,
            dropped_events: self.dropped,
            retained_bytes: self.bytes,
        })
    }
}

impl DebuggerService {
    pub fn events(&self, query: EventQuery) -> Result<EventPage> {
        self.with_state(|state, _, _| {
            if let Some(id) = &query.session_id {
                if !state.sessions.contains_key(id) {
                    return Err(error(ErrorCode::NotFound, "调试会话不存在或历史已淘汰"));
                }
            }
            state.events.page(&query)
        })
    }
}
