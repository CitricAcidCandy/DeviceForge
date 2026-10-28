//! 只接收有限工具和受限结构化数据，不提供任意脚本或凭据通道。

use super::*;
use serde_json::Value;
use std::collections::BTreeSet;

pub(super) fn error(code: ErrorCode, message: &str) -> DebuggerError {
    DebuggerError {
        code,
        message: message.into(),
    }
}

pub(super) fn identifier(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || value.chars().any(char::is_control)
        || value.trim() != value
    {
        return Err(error(
            ErrorCode::InvalidInput,
            "调试标识必须为非空、无控制字符且不超过 128 字节",
        ));
    }
    Ok(())
}

pub(super) fn instance_id(value: &str) -> Result<()> {
    if uuid::Uuid::parse_str(value).is_err() {
        return Err(error(
            ErrorCode::InvalidInput,
            "浏览器实例标识不是有效 UUID",
        ));
    }
    Ok(())
}

pub(super) fn plugins(items: &[BridgePlugin]) -> Result<()> {
    if items.len() > 64 {
        return Err(error(ErrorCode::Capacity, "单实例最多登记 64 个浏览器插件"));
    }
    let mut ids = BTreeSet::new();
    for plugin in items {
        identifier(&plugin.plugin_id)?;
        identifier(
            plugin
                .generation
                .as_deref()
                .ok_or_else(|| error(ErrorCode::InvalidInput, "浏览器插件必须登记非空代际"))?,
        )?;
        if let Some(version) = &plugin.version {
            identifier(version)?;
        }
        if !ids.insert(&plugin.plugin_id) {
            return Err(error(ErrorCode::InvalidInput, "浏览器插件目录包含重复标识"));
        }
    }
    Ok(())
}

pub(super) fn target(value: &DebugTarget) -> Result<()> {
    identifier(&value.plugin_id)?;
    identifier(
        value
            .generation
            .as_deref()
            .ok_or_else(|| error(ErrorCode::InvalidInput, "调试目标必须显式指定非空代际"))?,
    )?;
    if let Some(version) = &value.version {
        identifier(version)?;
    }
    match (&value.target_kind, &value.instance_id) {
        (TargetKind::Browser, Some(id)) => instance_id(id),
        (TargetKind::Server, None) => Ok(()),
        _ => Err(error(
            ErrorCode::InvalidInput,
            "浏览器目标必须指定实例，服务器目标不得指定实例",
        )),
    }
}

pub(super) fn payload(value: &Value) -> Result<()> {
    if !value.is_object() {
        return Err(error(ErrorCode::InvalidInput, "命令参数必须是 JSON 对象"));
    }
    let mut remaining = 4096;
    inspect(value, 0, 12, &mut remaining, &mut 0, false)?;
    encoded_size(value, 64 * 1024)?;
    Ok(())
}

pub(super) fn response(value: &Value) -> Result<()> {
    let mut remaining = 32_768;
    inspect(value, 0, 32, &mut remaining, &mut 0, true)?;
    encoded_size(value, 1024 * 1024)?;
    Ok(())
}

pub(super) fn encoded_size(value: &Value, limit: usize) -> Result<usize> {
    struct Counter {
        bytes: usize,
        limit: usize,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.bytes) {
                return Err(std::io::Error::other("调试数据超过编码字节上限"));
            }
            self.bytes += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    // 在限额处停止计数，不为拒绝超大输入再复制整份 JSON。
    let mut counter = Counter { bytes: 0, limit };
    serde_json::to_writer(&mut counter, value)
        .map_err(|_| error(ErrorCode::Capacity, "调试数据超过编码字节上限"))?;
    Ok(counter.bytes)
}

fn inspect(
    value: &Value,
    depth: usize,
    maximum_depth: usize,
    remaining: &mut usize,
    ui_nodes: &mut usize,
    is_response: bool,
) -> Result<()> {
    if depth > maximum_depth || *remaining == 0 {
        return Err(error(ErrorCode::Capacity, "调试数据结构超过深度或节点上限"));
    }
    *remaining -= 1;
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                if key.len() > 128 {
                    return Err(error(ErrorCode::Capacity, "调试字段名超过 128 字节"));
                }
                let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                if matches!(
                    normalized.as_str(),
                    "token"
                        | "accesstoken"
                        | "refreshtoken"
                        | "authorization"
                        | "cookie"
                        | "cookies"
                        | "password"
                        | "passwd"
                        | "secret"
                        | "credentials"
                        | "apikey"
                        | "privatekey"
                ) || normalized.ends_with("token")
                    || normalized.ends_with("password")
                    || normalized.ends_with("secret")
                    || normalized.ends_with("apikey")
                {
                    if !is_response || child.as_str() != Some("[已脱敏]") {
                        return Err(error(ErrorCode::InvalidInput, "调试数据包含禁止的凭据字段"));
                    }
                }
                if is_response && matches!(key.as_str(), "nodes" | "children") {
                    if let Value::Array(items) = child {
                        *ui_nodes += items.iter().filter(|item| item.is_object()).count();
                        if *ui_nodes > 500 {
                            return Err(error(
                                ErrorCode::Capacity,
                                "调试回执的 UI 节点不能超过 500 个",
                            ));
                        }
                    }
                }
                inspect(
                    child,
                    depth + 1,
                    maximum_depth,
                    remaining,
                    ui_nodes,
                    is_response,
                )?;
            }
        }
        Value::Array(items) => {
            for child in items {
                inspect(
                    child,
                    depth + 1,
                    maximum_depth,
                    remaining,
                    ui_nodes,
                    is_response,
                )?;
            }
        }
        Value::String(text) if text.len() > if is_response { 1024 * 1024 } else { 64 * 1024 } => {
            return Err(error(ErrorCode::Capacity, "调试文本超过单条上限"));
        }
        _ => {}
    }
    Ok(())
}
