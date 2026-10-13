use crate::{
    model::{TEXT_BYTE_LIMIT, normalize_thread},
    redaction::Redactor,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const EVENT_LIMIT: usize = 10_000;
const ITEM_KINDS: [&str; 7] = [
    "agent_message",
    "reasoning",
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
    "todo_list",
];

struct Item {
    public_id: String,
    kind: String,
    complete: bool,
}

pub struct Events {
    expected: Option<String>,
    thread: Option<String>,
    started: bool,
    complete: bool,
    count: usize,
    items: BTreeMap<String, Item>,
    raw_text: String,
    public_text: String,
    answers: usize,
    redactor: Redactor,
}

impl Events {
    pub fn new(expected: Option<&str>, redactor: Redactor) -> Result<Self, String> {
        Ok(Self {
            expected: expected.map(normalize_thread).transpose()?,
            thread: None,
            started: false,
            complete: false,
            count: 0,
            items: BTreeMap::new(),
            raw_text: String::new(),
            public_text: String::new(),
            answers: 0,
            redactor,
        })
    }

    pub fn thread(&self) -> Option<&str> {
        self.thread.as_deref()
    }
    pub fn count(&self) -> usize {
        self.count
    }
    pub fn public_text(&self) -> &str {
        &self.public_text
    }

    pub fn verify_candidate(&self, thread: &str, text: &str, count: usize) -> Result<(), String> {
        if !self.complete
            || !self.started
            || self.raw_text.trim().is_empty()
            || self.public_text.trim().is_empty()
            || self.thread.as_deref() != Some(thread)
            || self.raw_text != text
            || self.count != count
        {
            return Err("SDK成功候选与真实事件不匹配".into());
        }
        Ok(())
    }

    pub fn finish(&self) -> Result<Value, String> {
        if !self.complete
            || self.public_text.trim().is_empty()
            || self.items.values().any(|item| !item.complete)
        {
            return Err("SDK公开流缺少完整轮次或回答".into());
        }
        Ok(json!({"format_version":1,"type":"turn.completed"}))
    }

    pub fn event(&mut self, bytes: &[u8]) -> Result<Option<Value>, String> {
        if bytes.len() > 65_536 || self.complete || self.count >= EVENT_LIMIT {
            return Err("SDK真实事件行、数量或终态超限".into());
        }
        let value: Value =
            serde_json::from_slice(bytes).map_err(|_| "SDK真实事件不是UTF-8 JSON")?;
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .ok_or("SDK真实事件缺少类型")?;
        self.count += 1;
        match kind {
            "thread.started" => {
                if self.thread.is_some() || self.started {
                    return Err("SDK线程开始顺序冲突".into());
                }
                let thread = normalize_thread(
                    value
                        .get("thread_id")
                        .and_then(Value::as_str)
                        .ok_or("SDK线程事件标识无效")?,
                )?;
                if self
                    .expected
                    .as_ref()
                    .is_some_and(|expected| expected != &thread)
                {
                    return Err("SDK恢复线程与实际归属冲突".into());
                }
                self.thread = Some(thread.clone());
                Ok(Some(
                    json!({"format_version":1,"type":kind,"thread_id":thread}),
                ))
            }
            "turn.started" => {
                if self.started || self.thread.is_none() {
                    return Err("SDK轮次开始顺序冲突".into());
                }
                self.started = true;
                Ok(Some(json!({"format_version":1,"type":kind})))
            }
            "turn.completed" => {
                if !self.started || self.items.values().any(|item| !item.complete) {
                    return Err("SDK轮次结束早于条目完成".into());
                }
                self.complete = true;
                Ok(None)
            }
            "turn.failed" | "error" => Err("SDK提供者返回失败事件".into()),
            "item.started" | "item.updated" | "item.completed" => self.item(kind, &value),
            _ => Ok(None),
        }
    }

    fn item(&mut self, event: &str, value: &Value) -> Result<Option<Value>, String> {
        if !self.started {
            return Err("SDK条目早于轮次开始".into());
        }
        let item = value
            .get("item")
            .and_then(Value::as_object)
            .ok_or("SDK条目结构无效")?;
        let identifier = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|identifier| {
                !identifier.is_empty()
                    && identifier.len() <= 128
                    && identifier
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
            })
            .ok_or("SDK条目身份无效")?;
        let kind = item
            .get("type")
            .and_then(Value::as_str)
            .ok_or("SDK条目类型无效")?;
        if !ITEM_KINDS.contains(&kind) {
            return Ok(None);
        }
        let status = match item.get("status") {
            None => None,
            Some(Value::String(status))
                if ["in_progress", "completed", "failed"].contains(&status.as_str()) =>
            {
                Some(status.clone())
            }
            _ => return Err("SDK条目状态无效".into()),
        };
        let next_id = format!("item_{}", self.items.len() + 1);
        let state = self.items.entry(identifier.into()).or_insert_with(|| Item {
            public_id: next_id,
            kind: kind.into(),
            complete: false,
        });
        if state.complete || state.kind != kind {
            return Err("SDK条目重复完成或类型变化".into());
        }
        state.complete = event == "item.completed";
        let mut output =
            json!({"format_version":1,"type":event,"item":{"id":state.public_id,"type":kind}});
        if let Some(status) = status {
            output["item"]["status"] = json!(status);
        }
        if ["agent_message", "reasoning"].contains(&kind) {
            if let Some(text) = item.get("text") {
                let raw = text.as_str().ok_or("SDK条目正文类型无效")?;
                let public = self.redactor.text(raw)?;
                if event == "item.completed" && kind == "agent_message" {
                    append(&mut self.raw_text, raw, self.answers != 0)?;
                    append(&mut self.public_text, &public, self.answers != 0)?;
                    self.answers += 1;
                }
                output["item"]["text"] = json!(public);
            } else if event == "item.completed" && kind == "agent_message" {
                return Err("SDK完成回答条目缺少正文".into());
            }
        }
        Ok(Some(output))
    }
}

fn append(target: &mut String, text: &str, separated: bool) -> Result<(), String> {
    let separator = usize::from(separated);
    let remaining = TEXT_BYTE_LIMIT
        .saturating_sub(target.len())
        .saturating_sub(separator);
    if text.len() > remaining {
        return Err("SDK回答合并后超限".into());
    }
    if separator != 0 {
        target.push('\n');
    }
    target.push_str(text);
    Ok(())
}

#[cfg(test)]
#[path = "events_tests.rs"]
mod tests;
