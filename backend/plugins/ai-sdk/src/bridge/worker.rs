use super::{
    framing::{CHUNK_LIMIT, Role, bytes},
    transport::{Identity, Incoming, Outgoing, accept},
};
use crate::{
    config::Config,
    model::{PROFILE, SDK_VERSION, TEXT_BYTE_LIMIT, TurnInput},
    redaction::Redactor,
    resources::Resources,
    stream::{events::Events, output::Writer},
};
use deviceforge_plugin_runtime::InvocationContext;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio::{
    net::TcpListener,
    sync::{Mutex, mpsc, oneshot},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hello {
    kind: String,
    profile: String,
    sdk_version: String,
    process_id: u32,
}

pub fn hello(payload: Value, expected: Option<u32>) -> Result<u32, String> {
    let hello: Hello = serde_json::from_value(payload).map_err(|_| "SDK本机角色开始帧无效")?;
    if hello.kind != "hello"
        || hello.profile != PROFILE
        || hello.sdk_version != SDK_VERSION
        || hello.process_id == 0
        || expected.is_some_and(|expected| expected != hello.process_id)
    {
        return Err("SDK本机角色档案或进程身份冲突".into());
    }
    Ok(hello.process_id)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Candidate {
    kind: String,
    outcome: String,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    event_count: Option<usize>,
    #[serde(default)]
    error_code: Option<String>,
}

pub struct Success {
    pub thread_id: String,
    pub text: String,
    pub public_text: String,
    pub event_count: usize,
    pub final_event: Value,
    pub writer: Option<Writer>,
}

pub struct Work {
    pub config: Arc<Config>,
    pub input: TurnInput,
    pub project_root: PathBuf,
    pub temporary: PathBuf,
    pub proxy: PathBuf,
    pub output_schema: Option<Value>,
    pub resources: Arc<Resources>,
    pub writer: Option<Writer>,
    pub control: Arc<Mutex<Option<Outgoing>>>,
}

enum Phase {
    Events,
    Event(Vec<u8>),
    Candidate(Candidate, Vec<u8>),
    End(Candidate, Vec<u8>),
}

fn exact(payload: &Value, expected: &[&str]) -> Result<(), String> {
    let object = payload.as_object().ok_or("SDK本机负载不是对象")?;
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err("SDK本机负载字段无效".into());
    }
    Ok(())
}

fn echo(mut value: Value) -> Result<Value, String> {
    if value.get("type").and_then(Value::as_str) == Some("turn.completed") {
        let usage = value
            .get_mut("usage")
            .and_then(Value::as_object_mut)
            .ok_or("SDK真实结束事件缺少usage")?;
        if usage
            .get("cache_write_input_tokens")
            .is_none_or(Value::is_null)
        {
            usage.insert("cache_write_input_tokens".into(), json!(0));
        }
    }
    Ok(value)
}

async fn raw_event(
    context: &InvocationContext,
    receiver: &mut mpsc::Receiver<Value>,
) -> Result<Value, String> {
    tokio::select! {
        biased;
        _ = tokio::time::sleep_until(tokio::time::Instant::from_std(context.deadline())) => Err("SDK真实事件核对期限已到期".into()),
        _ = context.cancellation().cancelled_owned() => Err("SDK真实事件核对已取消".into()),
        event = receiver.recv() => event.ok_or_else(|| "SDK缺少对应真实CLI事件".into()),
    }
}

async fn receive(
    context: &InvocationContext,
    incoming: &mut Incoming,
    raw: &mut mpsc::Receiver<Value>,
    events: &mut Events,
    resources: &Arc<Resources>,
    writer: &mut Option<Writer>,
) -> Result<Success, String> {
    let mut phase = Phase::Events;
    while let Some(payload) = incoming.read(context).await? {
        let kind = payload
            .get("kind")
            .and_then(Value::as_str)
            .ok_or("SDK worker负载缺少类型")?;
        phase = match (phase, kind) {
            (Phase::Events, "event_start") => {
                exact(&payload, &["kind"])?;
                Phase::Event(Vec::new())
            }
            (Phase::Event(mut pending), "event_bytes") => {
                exact(&payload, &["kind", "bytes"])?;
                let chunk = bytes(&payload)?;
                if chunk.len() > 65_536usize.saturating_sub(pending.len()) {
                    return Err("SDK worker事件字节超限".into());
                }
                pending.extend_from_slice(&chunk);
                Phase::Event(pending)
            }
            (Phase::Event(pending), "event_end") => {
                exact(&payload, &["kind"])?;
                let actual: Value =
                    serde_json::from_slice(&pending).map_err(|_| "SDK worker事件不是UTF-8 JSON")?;
                if actual != echo(raw_event(context, raw).await?)? {
                    return Err("SDK事件与真实CLI输出不匹配".into());
                }
                let output = events.event(&pending)?;
                if actual.get("type").and_then(Value::as_str) == Some("thread.started") {
                    resources
                        .register(context, events.thread().ok_or("SDK实际线程缺失")?.into())
                        .await?;
                }
                if let (Some(output), Some(writer)) = (output, writer.as_mut()) {
                    writer.send(context, &output).await?;
                }
                Phase::Events
            }
            (Phase::Events, "candidate_start") => {
                let candidate: Candidate =
                    serde_json::from_value(payload).map_err(|_| "SDK worker候选字段无效")?;
                let valid = match candidate.outcome.as_str() {
                    "success" => {
                        candidate.thread_id.is_some()
                            && candidate
                                .event_count
                                .is_some_and(|count| count > 0 && count <= 10_000)
                            && candidate.error_code.is_none()
                    }
                    "cancelled" | "failed" => {
                        candidate.thread_id.is_none()
                            && candidate.event_count.is_none()
                            && candidate.error_code.as_deref().is_some_and(|code| {
                                ["transport_failed", "aborted", "provider_failed"].contains(&code)
                            })
                    }
                    _ => false,
                };
                if !valid || candidate.kind != "candidate_start" {
                    return Err("SDK worker候选资格无效".into());
                }
                Phase::Candidate(candidate, Vec::new())
            }
            (Phase::Candidate(candidate, mut pending), "text_bytes") => {
                exact(&payload, &["kind", "bytes"])?;
                if candidate.outcome != "success" {
                    return Err("SDK失败候选不得返回回答".into());
                }
                let chunk = bytes(&payload)?;
                if chunk.len() > TEXT_BYTE_LIMIT.saturating_sub(pending.len()) {
                    return Err("SDK worker候选正文超限".into());
                }
                pending.extend_from_slice(&chunk);
                Phase::Candidate(candidate, pending)
            }
            (Phase::Candidate(candidate, pending), "candidate_end") => {
                exact(&payload, &["kind"])?;
                Phase::End(candidate, pending)
            }
            _ => return Err("SDK worker私有帧顺序冲突".into()),
        };
    }
    let Phase::End(candidate, text) = phase else {
        return Err("SDK worker连接缺少完整候选".into());
    };
    if candidate.outcome != "success" {
        return Err("SDK worker未产生成功候选".into());
    }
    let text = String::from_utf8(text).map_err(|_| "SDK worker候选正文不是UTF-8")?;
    let thread_id =
        crate::model::normalize_thread(candidate.thread_id.as_deref().ok_or("SDK候选缺少线程")?)?;
    let event_count = candidate.event_count.ok_or("SDK候选缺少事件计数")?;
    events.verify_candidate(&thread_id, &text, event_count)?;
    Ok(Success {
        thread_id,
        text,
        public_text: events.public_text().into(),
        event_count,
        final_event: events.finish()?,
        writer: writer.take(),
    })
}

pub async fn run(
    listener: TcpListener,
    identity: Identity,
    mut work: Work,
    context: InvocationContext,
    ready: oneshot::Receiver<u32>,
    mut raw: mpsc::Receiver<Value>,
) -> Result<Success, String> {
    let (mut incoming, outgoing) = accept(&listener, &context, &identity, Role::Worker).await?;
    let handshake = tokio::time::Instant::from_std(context.deadline())
        .min(tokio::time::Instant::now() + std::time::Duration::from_millis(1000));
    let payload = incoming
        .read_until(handshake, context.cancellation())
        .await?
        .ok_or("SDK worker缺少本机开始帧")?;
    let node = tokio::select! {
        biased;
        _ = tokio::time::sleep_until(handshake) => return Err("SDK原生启动身份核对超时".into()),
        _ = context.cancellation().cancelled_owned() => return Err("SDK原生启动身份核对已取消".into()),
        node = ready => node.map_err(|_| "SDK原生监督未交付启动身份")?,
    };
    hello(payload, Some(node))?;
    *work.control.lock().await = Some(outgoing.clone());
    let mut begin = json!({
        "kind":"begin", "project_id":work.input.project_id, "project_root":work.project_root,
        "sdk_entry":work.config.sdk_entry, "proxy_executable":work.proxy,
        "temporary_root":work.temporary, "thread_options":work.config.thread_options,
    });
    if let Some(thread) = &work.input.thread_id {
        begin["thread_id"] = json!(thread);
    }
    if let Some(schema) = &work.output_schema {
        begin["output_schema"] = schema.clone();
    }
    outgoing.send(&context, begin).await?;
    for chunk in work.input.prompt.as_bytes().chunks(CHUNK_LIMIT) {
        outgoing
            .send(&context, json!({"kind":"prompt_bytes","bytes":chunk}))
            .await?;
    }
    outgoing
        .send(&context, json!({"kind":"prompt_end"}))
        .await?;
    let mut events = Events::new(
        work.input.thread_id.as_deref(),
        Redactor::for_config(&work.config),
    )?;
    receive(
        &context,
        &mut incoming,
        &mut raw,
        &mut events,
        &work.resources,
        &mut work.writer,
    )
    .await
}
