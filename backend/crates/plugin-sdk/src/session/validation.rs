//! 帧的纯身份、预算与字节限额校验，反序列化时先限制字节数组。
use super::{SESSION_CHUNK_LIMIT, SESSION_PROTOCOL_VERSION};
use crate::context::MAX_REMAINING_TIMEOUT_NS;
use crate::cooperative::{CancelReason, CleanupOutcome};
use serde::{Deserialize, de};
use std::fmt;

pub(super) fn identity(version: u32, id: &str) -> Result<(), &'static str> {
    if version != SESSION_PROTOCOL_VERSION {
        return Err("交互会话要求协议 5");
    }
    identifier(id)
}

fn identifier(id: &str) -> Result<(), &'static str> {
    if id.is_empty() || id.len() > 128 {
        return Err("会话 ID 必须为 1 至 128 字节");
    }
    Ok(())
}

pub(super) fn budget(value: u64) -> Result<(), &'static str> {
    if value > MAX_REMAINING_TIMEOUT_NS {
        return Err("剩余期限超过 3600000000000 纳秒");
    }
    Ok(())
}

pub(super) fn chunk(bytes: &[u8]) -> Result<(), &'static str> {
    if bytes.len() > SESSION_CHUNK_LIMIT {
        return Err("会话字节块超过 8192 字节");
    }
    Ok(())
}

pub(super) fn order(sequence: u64) -> Result<(), &'static str> {
    if sequence == 0 {
        return Err("会话序号必须大于零");
    }
    Ok(())
}

pub(super) fn version<'de, D: de::Deserializer<'de>>(decoder: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(decoder)?;
    identity(value, "id").map_err(de::Error::custom)?;
    Ok(value)
}

pub(super) fn session_id<'de, D: de::Deserializer<'de>>(decoder: D) -> Result<String, D::Error> {
    let value = String::deserialize(decoder)?;
    identifier(&value).map_err(de::Error::custom)?;
    Ok(value)
}

pub(super) fn remaining<'de, D: de::Deserializer<'de>>(decoder: D) -> Result<u64, D::Error> {
    let value = u64::deserialize(decoder)?;
    budget(value).map_err(de::Error::custom)?;
    Ok(value)
}

pub(super) fn sequence<'de, D: de::Deserializer<'de>>(decoder: D) -> Result<u64, D::Error> {
    let value = u64::deserialize(decoder)?;
    order(value).map_err(de::Error::custom)?;
    Ok(value)
}

pub(super) fn operation<'de, D: de::Deserializer<'de>>(decoder: D) -> Result<String, D::Error> {
    let value = String::deserialize(decoder)?;
    valid_operation(&value).map_err(de::Error::custom)?;
    Ok(value)
}

pub(super) fn valid_operation(operation: &str) -> Result<(), &'static str> {
    if operation.is_empty() || operation.len() > 128 {
        return Err("会话操作名必须为 1 至 128 字节");
    }
    Ok(())
}

pub(super) fn bytes<'de, D: de::Deserializer<'de>>(decoder: D) -> Result<Vec<u8>, D::Error> {
    struct BoundedBytes;
    impl<'de> de::Visitor<'de> for BoundedBytes {
        type Value = Vec<u8>;
        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("最多 8192 个字节组成的数组")
        }
        fn visit_seq<A: de::SeqAccess<'de>>(self, mut source: A) -> Result<Vec<u8>, A::Error> {
            let mut result =
                Vec::with_capacity(source.size_hint().unwrap_or(0).min(SESSION_CHUNK_LIMIT));
            while let Some(byte) = source.next_element::<u8>()? {
                if result.len() == SESSION_CHUNK_LIMIT {
                    return Err(de::Error::custom("会话字节块超过 8192 字节"));
                }
                result.push(byte);
            }
            Ok(result)
        }
    }
    decoder.deserialize_seq(BoundedBytes)
}

pub(super) fn cancel_reason<'de, D: de::Deserializer<'de>>(
    decoder: D,
) -> Result<CancelReason, D::Error> {
    match String::deserialize(decoder)?.as_str() {
        "cancelled" => Ok(CancelReason::Cancelled),
        "timeout" => Ok(CancelReason::Timeout),
        "transport_failure" => Ok(CancelReason::TransportFailure),
        _ => Err(de::Error::custom("会话取消原因无效")),
    }
}

pub(super) fn cleanup<'de, D: de::Deserializer<'de>>(
    decoder: D,
) -> Result<CleanupOutcome, D::Error> {
    match String::deserialize(decoder)?.as_str() {
        "complete" => Ok(CleanupOutcome::Complete),
        "failed" => Ok(CleanupOutcome::Failed),
        _ => Err(de::Error::custom("会话清理结果必须为 complete 或 failed")),
    }
}
