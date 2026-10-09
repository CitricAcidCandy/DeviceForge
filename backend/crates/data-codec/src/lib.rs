//! 独立的受限数据编解码，不依赖宿主领域、任务、文件系统或 HTTP。
mod json;
mod wire;
use serde_json::{Map, Number, Value};
use std::io::{Cursor, Write};
pub const MAX_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_DEPTH: usize = 64;
pub const MAX_NODES: usize = 100_000;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("数据超过 16 MiB、64 层或 100000 节点的资源边界")]
    Limit,
    #[error("数据格式无效、截断、保留标记或包含尾随内容")]
    Invalid,
    #[error("数据不能保真转换为普通 JSON：{0}")]
    Unsupported(&'static str),
}
pub type Result<T> = std::result::Result<T, Error>;
pub fn parse_json(bytes: &[u8]) -> Result<Value> {
    json::parse(bytes)
}
pub fn validate_msgpack(bytes: &[u8]) -> Result<()> {
    wire::validate(bytes)
}
pub fn decode_json(bytes: &[u8]) -> Result<Value> {
    validate_msgpack(bytes)?;
    let value = rmpv::decode::read_value_with_max_depth(&mut Cursor::new(bytes), MAX_DEPTH * 4 + 8)
        .map_err(|_| Error::Invalid)?;
    to_json(value)
}
fn to_json(value: rmpv::Value) -> Result<Value> {
    Ok(match value {
        rmpv::Value::Nil => Value::Null,
        rmpv::Value::Boolean(value) => Value::Bool(value),
        rmpv::Value::Integer(value) => Value::Number(if let Some(value) = value.as_u64() {
            Number::from(value)
        } else {
            Number::from(value.as_i64().ok_or(Error::Invalid)?)
        }),
        rmpv::Value::F32(value) => {
            Value::Number(Number::from_f64(value as f64).ok_or(Error::Unsupported("非有限浮点数"))?)
        }
        rmpv::Value::F64(value) => {
            Value::Number(Number::from_f64(value).ok_or(Error::Unsupported("非有限浮点数"))?)
        }
        rmpv::Value::String(value) => Value::String(
            value
                .into_str()
                .ok_or(Error::Unsupported("非 UTF-8 字符串"))?,
        ),
        rmpv::Value::Array(values) => {
            Value::Array(values.into_iter().map(to_json).collect::<Result<_>>()?)
        }
        rmpv::Value::Map(entries) => {
            let mut map = Map::new();
            for (key, value) in entries {
                let rmpv::Value::String(key) = key else {
                    return Err(Error::Unsupported("非字符串映射键"));
                };
                let key = key
                    .into_str()
                    .ok_or(Error::Unsupported("非 UTF-8 映射键"))?;
                if map.contains_key(&key) {
                    return Err(Error::Unsupported("重复映射键"));
                }
                map.insert(key, to_json(value)?);
            }
            Value::Object(map)
        }
        rmpv::Value::Binary(_) => return Err(Error::Unsupported("二进制值")),
        rmpv::Value::Ext(_, _) => return Err(Error::Unsupported("扩展值")),
    })
}
fn to_msgpack(value: Value) -> rmpv::Value {
    match value {
        Value::Null => rmpv::Value::Nil,
        Value::Bool(value) => rmpv::Value::Boolean(value),
        Value::Number(value) => {
            if let Some(value) = value.as_u64() {
                rmpv::Value::from(value)
            } else if let Some(value) = value.as_i64() {
                rmpv::Value::from(value)
            } else {
                rmpv::Value::F64(value.as_f64().expect("JSON 有限浮点数"))
            }
        }
        Value::String(value) => rmpv::Value::from(value),
        Value::Array(values) => rmpv::Value::Array(values.into_iter().map(to_msgpack).collect()),
        Value::Object(values) => rmpv::Value::Map(
            values
                .into_iter()
                .map(|(key, value)| (rmpv::Value::from(key), to_msgpack(value)))
                .collect(),
        ),
    }
}
struct Limited(Vec<u8>);
impl Write for Limited {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_BYTES {
            return Err(std::io::Error::other("转换输出超过 16 MiB"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub fn encode_json(bytes: &[u8]) -> Result<Vec<u8>> {
    let value = to_msgpack(parse_json(bytes)?);
    let mut writer = Limited(Vec::new());
    rmpv::encode::write_value(&mut writer, &value).map_err(|_| Error::Limit)?;
    Ok(writer.0)
}
pub fn json_bytes(value: &Value) -> Result<Vec<u8>> {
    let mut writer = Limited(Vec::new());
    serde_json::to_writer(&mut writer, value).map_err(|_| Error::Limit)?;
    Ok(writer.0)
}
#[cfg(test)]
mod tests;
