//! 产物引用的纯选择规则；在创建目录、读取存储前完成全部输入校验。
use apk_domain::{Error, Result};
use apk_plugin_sdk::ArtifactAccess;
use serde_json::Value;
use std::collections::HashSet;

pub(super) const MAX_FILES: usize = 8;
const MAX_POINTER_BYTES: usize = 256;
const MAX_POINTER_DEPTH: usize = 8;

pub(super) struct SelectedInput<'a> {
    pub field: &'a str,
    pub artifact_id: &'a str,
}

pub(super) fn validate(access: &ArtifactAccess) -> Result<()> {
    if access
        .input_fields
        .len()
        .saturating_add(access.input_pointers.len())
        > MAX_FILES
    {
        return Err(Error::Invalid("插件产物输入选择器合计最多 8 个".into()));
    }
    let mut paths = HashSet::new();
    for field in &access.input_fields {
        if field.is_empty()
            || field.len() > 80
            || !field
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            || !paths.insert(format!("/{field}"))
        {
            return Err(Error::Invalid(
                "插件产物字段必须为唯一的顶层字段名称".into(),
            ));
        }
    }
    for pointer in &access.input_pointers {
        if !valid_pointer(pointer) || !paths.insert(pointer.clone()) {
            return Err(Error::Invalid(
                "插件产物路径必须为唯一且有界的 JSON Pointer".into(),
            ));
        }
    }
    Ok(())
}

fn valid_pointer(pointer: &str) -> bool {
    let Some(tail) = pointer.strip_prefix('/') else {
        return false;
    };
    pointer.len() <= MAX_POINTER_BYTES
        && tail.split('/').count() <= MAX_POINTER_DEPTH
        && tail.split('/').all(|token| {
            let mut bytes = token.bytes();
            while let Some(byte) = bytes.next() {
                if byte == b'~' && !matches!(bytes.next(), Some(b'0' | b'1')) {
                    return false;
                }
            }
            true
        })
}

pub(super) fn select<'a>(
    access: &'a ArtifactAccess,
    input: &'a Value,
) -> Result<Vec<SelectedInput<'a>>> {
    validate(access)?;
    let mut selected = Vec::new();
    for field in &access.input_fields {
        if let Some(value) = input.get(field) {
            push_ids(&mut selected, field, value)?;
        }
    }
    for pointer in &access.input_pointers {
        if let Some(value) = resolve(input, pointer)? {
            push_ids(&mut selected, pointer, value)?;
        }
    }
    Ok(selected)
}

fn resolve<'a>(input: &'a Value, pointer: &str) -> Result<Option<&'a Value>> {
    let mut current = input;
    for encoded in pointer[1..].split('/') {
        let token = encoded.replace("~1", "/").replace("~0", "~");
        let next = match current {
            Value::Object(object) => object.get(&token),
            Value::Array(array) => {
                if token.is_empty()
                    || (token.len() > 1 && token.starts_with('0'))
                    || !token.bytes().all(|byte| byte.is_ascii_digit())
                {
                    return Err(Error::Invalid(
                        "产物路径的数组索引必须为规范十进制整数".into(),
                    ));
                }
                // 规范索引超过宿主整数范围时必然超出数组长度，按缺失处理。
                token
                    .parse::<usize>()
                    .ok()
                    .and_then(|index| array.get(index))
            }
            _ => return Err(Error::Invalid("产物路径中间值必须为对象或数组".into())),
        };
        let Some(next) = next else {
            return Ok(None);
        };
        current = next;
    }
    Ok(Some(current))
}

fn push_ids<'a>(
    selected: &mut Vec<SelectedInput<'a>>,
    field: &'a str,
    value: &'a Value,
) -> Result<()> {
    let push = |selected: &mut Vec<SelectedInput<'a>>, value: &'a Value| -> Result<()> {
        let artifact_id = value
            .as_str()
            .ok_or_else(|| Error::Invalid("产物字段必须为 ID 字符串或全字符串数组".into()))?;
        if selected.len() >= MAX_FILES {
            return Err(Error::Invalid("单次插件最多读取 8 个产物".into()));
        }
        selected.push(SelectedInput { field, artifact_id });
        Ok(())
    };
    if let Some(values) = value.as_array() {
        for value in values {
            push(selected, value)?;
        }
        Ok(())
    } else {
        push(selected, value)
    }
}

#[cfg(test)]
mod tests;
