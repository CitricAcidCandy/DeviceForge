use crate::{Error, MAX_BYTES, MAX_DEPTH, MAX_NODES, Result};
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::{cell::Cell, fmt};
struct Seed<'a> {
    nodes: &'a Cell<usize>,
    depth: usize,
}
impl Seed<'_> {
    fn count<E: de::Error>(&self) -> std::result::Result<(), E> {
        self.nodes.set(self.nodes.get() + 1);
        if self.depth > MAX_DEPTH || self.nodes.get() > MAX_NODES {
            return Err(E::custom("资源边界"));
        }
        Ok(())
    }
}
impl<'de> DeserializeSeed<'de> for Seed<'_> {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> std::result::Result<Value, D::Error> {
        self.count()?;
        deserializer.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Seed<'_> {
    type Value = Value;
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("受限 JSON 值")
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<Value, E> {
        Ok(Value::Bool(value))
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<Value, E> {
        Ok(Value::Number(value.into()))
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> std::result::Result<Value, E> {
        Ok(Value::Number(value.into()))
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> std::result::Result<Value, E> {
        Ok(Value::Number(
            Number::from_f64(value).ok_or_else(|| E::custom("非有限数值"))?,
        ))
    }
    fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<Value, E> {
        Ok(Value::String(value.into()))
    }
    fn visit_string<E: de::Error>(self, value: String) -> std::result::Result<Value, E> {
        Ok(Value::String(value))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> std::result::Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = access.next_element_seed(Seed {
            nodes: self.nodes,
            depth: self.depth + 1,
        })? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> std::result::Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = access.next_key::<String>()? {
            self.count()?;
            if values.contains_key(&key) {
                return Err(de::Error::custom("重复 JSON 键"));
            }
            let value = access.next_value_seed(Seed {
                nodes: self.nodes,
                depth: self.depth + 1,
            })?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}
// 防止超出 64 位范围的整数被 JSON 库悄悄解释为有精度损失的浮点数。
fn integer_tokens(bytes: &[u8]) -> Result<()> {
    let mut position = 0;
    while position < bytes.len() {
        match bytes[position] {
            b'"' => {
                position += 1;
                while position < bytes.len() {
                    if bytes[position] == b'\\' {
                        position = position.saturating_add(2);
                    } else if bytes[position] == b'"' {
                        position += 1;
                        break;
                    } else {
                        position += 1;
                    }
                }
            }
            b'-' | b'0'..=b'9' => {
                let start = position;
                position += 1;
                while position < bytes.len()
                    && (bytes[position].is_ascii_digit() || b".eE+-".contains(&bytes[position]))
                {
                    position += 1;
                }
                let token = &bytes[start..position];
                if !token.iter().any(|c| b".eE".contains(c)) {
                    let number = std::str::from_utf8(token).map_err(|_| Error::Invalid)?;
                    let valid = if token[0] == b'-' {
                        number.parse::<i64>().is_ok()
                    } else {
                        number.parse::<u64>().is_ok()
                    };
                    if !valid {
                        return Err(Error::Unsupported("整数超过 64 位范围"));
                    }
                }
            }
            _ => position += 1,
        }
    }
    Ok(())
}
pub(super) fn parse(bytes: &[u8]) -> Result<Value> {
    if bytes.len() > MAX_BYTES {
        return Err(Error::Limit);
    }
    integer_tokens(bytes)?;
    let nodes = Cell::new(0);
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let value = Seed {
        nodes: &nodes,
        depth: 0,
    }
    .deserialize(&mut deserializer)
    .map_err(|error| {
        if error.to_string().contains("资源边界") {
            Error::Limit
        } else {
            Error::Invalid
        }
    })?;
    deserializer.end().map_err(|_| Error::Invalid)?;
    Ok(value)
}
