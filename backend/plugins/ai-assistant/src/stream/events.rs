use crate::model::valid_thread;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const LINE_LIMIT: usize = 64 * 1024;
pub(crate) const TEXT_LIMIT: usize = 512 * 1024;

#[derive(Default)]
struct Item {
    kind: String,
    completed: bool,
    public_id: String,
}

pub(crate) struct Events {
    pending: Vec<u8>,
    count: usize,
    expected: Option<String>,
    thread: Option<String>,
    thread_seen: bool,
    started: bool,
    completed: bool,
    items: BTreeMap<String, Item>,
    secrets: Vec<String>,
    text: String,
}

impl Events {
    pub(crate) fn new(
        expected: Option<String>,
        environment: &BTreeMap<String, String>,
    ) -> Result<Self, String> {
        if environment.len() > 128 || environment.values().any(|value| value.len() > 4096) {
            return Err("AI实时输出部署环境条目或脱敏值超限".into());
        }
        let unique: BTreeSet<_> = environment
            .values()
            .filter(|value| !value.is_empty())
            .cloned()
            .collect();
        let mut secrets: Vec<_> = unique.into_iter().collect();
        secrets.sort_by_key(|value| std::cmp::Reverse(value.len()));
        let expected = expected.map(|id| id.to_ascii_lowercase());
        Ok(Self {
            pending: Vec::new(),
            count: 0,
            thread: expected.clone(),
            expected,
            thread_seen: false,
            started: false,
            completed: false,
            items: BTreeMap::new(),
            secrets,
            text: String::new(),
        })
    }

    pub(crate) fn feed(&mut self, bytes: &[u8]) -> Result<Vec<Value>, String> {
        let mut output = Vec::new();
        for byte in bytes {
            if *byte == b'\n' {
                let line = std::mem::take(&mut self.pending);
                if let Some(event) = self.line(&line)? {
                    output.push(event);
                }
            } else {
                if self.pending.len() >= LINE_LIMIT {
                    return Err("AI提供者JSON行超过64KiB".into());
                }
                self.pending.push(*byte);
            }
        }
        Ok(output)
    }

    pub(crate) fn finish(&mut self) -> Result<Vec<Value>, String> {
        let mut output = Vec::new();
        if !self.pending.is_empty() {
            let line = std::mem::take(&mut self.pending);
            if let Some(event) = self.line(&line)? {
                output.push(event);
            }
        }
        if !self.completed || self.text.trim().is_empty() || self.thread.is_none() {
            return Err("AI实时输出缺少完整轮次、线程或回答".into());
        }
        Ok(output)
    }

    pub(crate) fn thread(&self) -> Option<&str> {
        self.thread.as_deref()
    }

    pub(crate) fn text(&self) -> &str {
        &self.text
    }

    fn redact(&self, text: &str) -> String {
        let mut parts = vec![Some(text)];
        for secret in &self.secrets {
            let mut next = Vec::new();
            for part in parts {
                match part {
                    None => next.push(None),
                    Some(part) => {
                        for (index, fragment) in part.split(secret).enumerate() {
                            if index != 0 {
                                next.push(None);
                            }
                            if !fragment.is_empty() {
                                next.push(Some(fragment));
                            }
                        }
                    }
                }
            }
            parts = next;
        }
        parts
            .into_iter()
            .map(|part| part.unwrap_or("[已隐藏]"))
            .collect()
    }

    fn line(&mut self, line: &[u8]) -> Result<Option<Value>, String> {
        let line = std::str::from_utf8(line).map_err(|_| "AI提供者JSON行不是UTF-8")?;
        if line.trim().is_empty() {
            return Ok(None);
        }
        if self.completed {
            return Err("AI提供者完成后仍返回事件".into());
        }
        if self.count >= 10000 {
            return Err("AI实时事件数量超过10000".into());
        }
        self.count += 1;
        let value: Value = serde_json::from_str(line).map_err(|_| "AI提供者未返回JSON事件")?;
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .ok_or("AI事件缺少类型")?;
        match kind {
            "thread.started" => {
                if self.thread_seen || self.started {
                    return Err("AI线程开始事件重复或晚于轮次".into());
                }
                let id = value
                    .get("thread_id")
                    .and_then(Value::as_str)
                    .filter(|id| valid_thread(id))
                    .ok_or("AI线程开始事件标识无效")?
                    .to_ascii_lowercase();
                if self
                    .expected
                    .as_ref()
                    .is_some_and(|expected| expected != &id)
                {
                    return Err("AI提供者线程与恢复请求不匹配".into());
                }
                self.thread = Some(id.clone());
                self.thread_seen = true;
                Ok(Some(json!({"format_version":1,"type":kind,"thread_id":id})))
            }
            "turn.started" => {
                if self.started || self.thread.is_none() {
                    return Err("AI轮次开始事件重复或缺少线程".into());
                }
                self.started = true;
                Ok(Some(json!({"format_version":1,"type":kind})))
            }
            "turn.completed" => {
                if !self.started || self.items.values().any(|item| !item.completed) {
                    return Err("AI提供者轮次未开始或条目未完成".into());
                }
                self.completed = true;
                Ok(Some(json!({"format_version":1,"type":kind})))
            }
            "turn.failed" | "error" => Err("AI提供者返回失败事件，诊断已隐藏".into()),
            "item.started" | "item.updated" | "item.completed" => self.item(kind, &value),
            _ => Ok(None),
        }
    }

    fn item(&mut self, event: &str, value: &Value) -> Result<Option<Value>, String> {
        if !self.started {
            return Err("AI条目事件早于轮次开始".into());
        }
        let item = value
            .get("item")
            .and_then(Value::as_object)
            .ok_or("AI条目无效")?;
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| identifier(id))
            .ok_or("AI条目标识无效")?;
        let kind = item
            .get("type")
            .and_then(Value::as_str)
            .ok_or("AI条目缺少类型")?;
        if ![
            "agent_message",
            "reasoning",
            "command_execution",
            "file_change",
            "mcp_tool_call",
            "web_search",
            "todo_list",
        ]
        .contains(&kind)
        {
            return Ok(None);
        }
        let status = match item.get("status") {
            None => None,
            Some(Value::String(status))
                if ["in_progress", "completed", "failed"].contains(&status.as_str()) =>
            {
                Some(status)
            }
            _ => return Err("AI条目状态无效".into()),
        };
        let next_id = format!("item_{}", self.items.len() + 1);
        let state = self.items.entry(id.to_owned()).or_insert_with(|| Item {
            public_id: next_id,
            ..Item::default()
        });
        if state.completed || (!state.kind.is_empty() && state.kind != kind) {
            return Err("AI条目重复完成或类型变化".into());
        }
        state.kind = kind.to_owned();
        state.completed = event == "item.completed";
        let mut output =
            json!({"format_version":1,"type":event,"item":{"id":state.public_id,"type":kind}});
        if let Some(status) = status {
            output["item"]["status"] = json!(status);
        }
        if ["agent_message", "reasoning"].contains(&kind) {
            if let Some(text) = item.get("text") {
                let text = text.as_str().ok_or("AI正文不是字符串")?;
                let text = self.redact(text);
                if text.len() > TEXT_LIMIT {
                    return Err("AI脱敏正文超过512KiB".into());
                }
                if event == "item.completed" && kind == "agent_message" {
                    let separator = usize::from(!self.text.is_empty());
                    if text.len() > TEXT_LIMIT.saturating_sub(self.text.len() + separator) {
                        return Err("AI回答超过512KiB".into());
                    }
                    if separator != 0 {
                        self.text.push('\n');
                    }
                    self.text.push_str(&text);
                }
                output["item"]["text"] = json!(text);
            } else if event == "item.completed" && kind == "agent_message" {
                return Err("AI完成的回答条目缺少正文".into());
            }
        }
        Ok(Some(output))
    }
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:-".contains(&byte))
}

#[cfg(test)]
mod tests;
