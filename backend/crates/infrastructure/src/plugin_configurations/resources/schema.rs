//! 托管入口沿公开模式选择唯一分支，只补缺失的必需常量，不覆盖现有判别字段。
use apk_domain::{Error, Result};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

const LIMIT: usize = 64;
static OPEN_SCHEMA: Value = Value::Bool(true);
type Branch<'a> = Vec<&'a Value>;

pub(super) fn bind(
    root: &Value,
    values: &Value,
    pointer: &str,
    replacement: Value,
) -> Result<Value> {
    if !pointer.starts_with('/') || pointer.len() > 512 {
        return Err(invalid("工具绑定配置指针无效"));
    }
    let parts: Vec<String> = pointer[1..]
        .split('/')
        .map(|part| part.replace("~1", "/").replace("~0", "~"))
        .collect();
    let mut budget = 0;
    let mut candidates = descend(root, &[root], values, &parts, &replacement, &mut budget)?;
    match candidates.len() {
        0 => Err(invalid("工具绑定与现有配置或模式分支不匹配")),
        1 => Ok(candidates.remove(0)),
        _ => Err(invalid("工具绑定配置模式存在歧义，须先明确配置分支")),
    }
}

fn descend(
    root: &Value,
    schemas: &[&Value],
    current: &Value,
    parts: &[String],
    replacement: &Value,
    budget: &mut usize,
) -> Result<Vec<Value>> {
    if parts.is_empty() {
        return Ok(vec![replacement.clone()]);
    }
    let mut branches = vec![Vec::new()];
    for schema in schemas {
        branches = product(branches, expand(root, schema, &mut Vec::new(), budget)?)?;
    }
    let mut output = Vec::new();
    for branch in branches {
        let mut candidate = current.clone();
        if candidate.is_null() {
            candidate = Value::Object(Map::new());
        }
        if !branch
            .iter()
            .all(|schema| permits_container(schema, &candidate))
        {
            continue;
        }
        let (child, child_schemas) = if let Some(object) = candidate.as_object_mut() {
            if !constants(root, &branch, object, budget)? {
                continue;
            }
            let Some(child_schemas) = property(&branch, &parts[0]) else {
                continue;
            };
            (
                object.entry(&parts[0]).or_insert(Value::Null),
                child_schemas,
            )
        } else if let Some(items) = candidate.as_array_mut() {
            let Some(index) = parts[0]
                .parse::<usize>()
                .ok()
                .filter(|index| index.to_string() == parts[0])
            else {
                return Err(invalid("工具绑定数组下标必须引用已有项"));
            };
            let Some(child) = items.get_mut(index) else {
                return Err(invalid("工具绑定数组下标必须引用已有项"));
            };
            let child_schemas = branch
                .iter()
                .map(|schema| {
                    schema
                        .get("prefixItems")
                        .and_then(Value::as_array)
                        .and_then(|prefix| prefix.get(index))
                        .or_else(|| schema.get("items"))
                        .unwrap_or(&OPEN_SCHEMA)
                })
                .collect::<Vec<_>>();
            if child_schemas.is_empty() {
                continue;
            }
            (child, child_schemas)
        } else {
            continue;
        };
        for value in descend(
            root,
            &child_schemas,
            child,
            &parts[1..],
            replacement,
            budget,
        )? {
            let mut result = candidate.clone();
            super::set_pointer(&mut result, &format!("/{}", escape(&parts[0])), value)?;
            // 无关组合分支得到相同配置时只有一个实际选择，不能误报歧义。
            if !output.contains(&result) {
                output.push(result);
            }
            if output.len() > LIMIT {
                return Err(invalid("工具绑定配置模式分支超过上限"));
            }
        }
    }
    Ok(output)
}

fn permits_container(schema: &Value, value: &Value) -> bool {
    if schema == &Value::Bool(false) {
        return false;
    }
    let expected = if value.is_object() { "object" } else { "array" };
    match schema.get("type") {
        Some(Value::String(kind)) => kind == expected,
        Some(Value::Array(kinds)) => kinds.iter().any(|kind| kind.as_str() == Some(expected)),
        _ => true,
    }
}

fn property<'a>(schemas: &[&'a Value], name: &str) -> Option<Vec<&'a Value>> {
    let mut output = Vec::new();
    for schema in schemas {
        let mut declared = false;
        if let Some(property) = schema.get("properties").and_then(|value| value.get(name)) {
            output.push(property);
            declared = true;
        }
        if let Some(patterns) = schema.get("patternProperties").and_then(Value::as_object) {
            for (pattern, property) in patterns {
                let matcher = serde_json::json!({"type":"string","pattern":pattern});
                if jsonschema::is_valid(&matcher, &Value::String(name.into())) {
                    output.push(property);
                    declared = true;
                }
            }
        }
        if !declared {
            match schema.get("additionalProperties") {
                Some(Value::Bool(false)) => return None,
                Some(additional) => output.push(additional),
                None => output.push(&OPEN_SCHEMA),
            }
        }
    }
    Some(output)
}

fn constants(
    root: &Value,
    schemas: &[&Value],
    object: &mut Map<String, Value>,
    budget: &mut usize,
) -> Result<bool> {
    let required: BTreeSet<&str> = schemas
        .iter()
        .filter_map(|schema| schema.get("required").and_then(Value::as_array))
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    for key in required {
        for property in schemas
            .iter()
            .filter_map(|schema| schema.get("properties").and_then(|value| value.get(key)))
        {
            let branches = expand(root, property, &mut Vec::new(), budget)?;
            // 属性本身仍有多种选择时，不凭某个分支推断常量。
            if branches.len() != 1 {
                continue;
            }
            for value in branches[0].iter().filter_map(|schema| schema.get("const")) {
                if let Some(current) = object.get(key) {
                    if current != value {
                        return Ok(false);
                    }
                } else {
                    object.insert(key.into(), value.clone());
                }
            }
        }
    }
    Ok(true)
}

fn expand<'a>(
    root: &'a Value,
    schema: &'a Value,
    active: &mut Vec<&'a Value>,
    budget: &mut usize,
) -> Result<Vec<Branch<'a>>> {
    *budget += 1;
    if *budget > 1024 || active.len() >= LIMIT {
        return Err(invalid("工具绑定配置模式展开超过上限"));
    }
    if active.iter().any(|value| std::ptr::eq(*value, schema)) {
        return Err(invalid("工具绑定配置模式含循环引用"));
    }
    active.push(schema);
    let mut branches = vec![vec![schema]];
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let target = reference
            .strip_prefix('#')
            .and_then(|pointer| root.pointer(pointer))
            .ok_or_else(|| invalid("工具绑定配置模式引用无效"))?;
        branches = product(branches, expand(root, target, active, budget)?)?;
    }
    if let Some(group) = schema.get("allOf").and_then(Value::as_array) {
        for child in group {
            branches = product(branches, expand(root, child, active, budget)?)?;
        }
    }
    for keyword in ["anyOf", "oneOf"] {
        if let Some(group) = schema.get(keyword).and_then(Value::as_array) {
            let mut alternatives = Vec::new();
            for child in group {
                alternatives.extend(expand(root, child, active, budget)?);
                if alternatives.len() > LIMIT {
                    return Err(invalid("工具绑定配置模式分支超过上限"));
                }
            }
            branches = product(branches, alternatives)?;
        }
    }
    active.pop();
    Ok(branches)
}

fn product<'a>(left: Vec<Branch<'a>>, right: Vec<Branch<'a>>) -> Result<Vec<Branch<'a>>> {
    if left.len().saturating_mul(right.len()) > LIMIT {
        return Err(invalid("工具绑定配置模式分支超过上限"));
    }
    Ok(left
        .into_iter()
        .flat_map(|left| {
            right.iter().map(move |right| {
                let mut branch = left.clone();
                branch.extend(right);
                branch
            })
        })
        .collect())
}

fn escape(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}

#[cfg(test)]
mod tests;
