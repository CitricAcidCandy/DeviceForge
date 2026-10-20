//! 配置注解按本地引用与组合模式合并，安全注解不因分支切换而失效。
use apk_domain::{Error, Result};
use serde_json::{Value, json};

pub(super) fn validate(schema: &Value) -> Result<()> {
    match schema {
        Value::Object(fields) => {
            if fields.contains_key("$dynamicRef")
                || fields.contains_key("$recursiveRef")
                || fields
                    .get("$ref")
                    .and_then(Value::as_str)
                    .is_some_and(|value| {
                        (value != "#" && !value.starts_with("#/")) || value.contains('%')
                    })
            {
                return Err(Error::Invalid(
                    "配置模式引用仅支持未编码的本地 JSON Pointer".into(),
                ));
            }
            for child in fields.values() {
                validate(child)?;
            }
        }
        Value::Array(values) => {
            for child in values {
                validate(child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn expanded<'a>(root: &'a Value, seeds: &[&'a Value]) -> Vec<&'a Value> {
    let mut output: Vec<&'a Value> = Vec::new();
    let mut queue = seeds.to_vec();
    while let Some(schema) = queue.pop() {
        if output.iter().any(|value| std::ptr::eq(*value, schema)) {
            continue;
        }
        output.push(schema);
        if let Some(reference) = schema.get("$ref").and_then(Value::as_str)
            && let Some(target) = reference
                .strip_prefix('#')
                .and_then(|path| root.pointer(path))
        {
            queue.push(target);
        }
        for group in ["allOf", "anyOf", "oneOf"] {
            if let Some(values) = schema.get(group).and_then(Value::as_array) {
                queue.extend(values);
            }
        }
        // 所有可选分支均保留安全注解，不能用修改判别字段绕过只读或敏感保护。
        for branch in ["then", "else"] {
            if let Some(value) = schema.get(branch) {
                queue.push(value);
            }
        }
        for map in ["dependentSchemas", "dependencies"] {
            if let Some(values) = schema.get(map).and_then(Value::as_object) {
                queue.extend(values.values().filter(|value| value.is_object()));
            }
        }
    }
    output
}

pub(super) fn property<'a>(schemas: &[&'a Value], name: &str) -> Vec<&'a Value> {
    let mut output = Vec::new();
    for schema in schemas {
        let mut matched = false;
        if let Some(value) = schema.get("properties").and_then(|value| value.get(name)) {
            output.push(value);
            matched = true;
        }
        if let Some(patterns) = schema.get("patternProperties").and_then(Value::as_object) {
            for (pattern, value) in patterns {
                let matcher = json!({ "type": "string", "pattern": pattern });
                if jsonschema::is_valid(&matcher, &json!(name)) {
                    output.push(value);
                    matched = true;
                }
            }
        }
        if !matched && let Some(value) = schema.get("additionalProperties") {
            output.push(value);
        }
        if let Some(value) = schema.get("unevaluatedProperties") {
            output.push(value);
        }
    }
    output
}

pub(super) fn item<'a>(schemas: &[&'a Value], index: usize) -> Vec<&'a Value> {
    let mut output = Vec::new();
    for schema in schemas {
        if let Some(prefix) = schema.get("prefixItems").and_then(Value::as_array)
            && let Some(value) = prefix.get(index)
        {
            output.push(value);
        } else if let Some(items) = schema.get("items") {
            if let Some(tuple) = items.as_array() {
                if let Some(value) = tuple.get(index) {
                    output.push(value);
                } else if let Some(value) = schema.get("additionalItems") {
                    output.push(value);
                }
            } else {
                output.push(items);
            }
        }
        // contains 也可向匹配成员提供安全注解；保守地保护所有成员。
        for keyword in ["contains", "unevaluatedItems"] {
            if let Some(value) = schema.get(keyword) {
                output.push(value);
            }
        }
    }
    output
}

pub(super) fn sensitive(schemas: &[&Value]) -> bool {
    schemas.iter().any(|schema| {
        schema.get("writeOnly").and_then(Value::as_bool) == Some(true)
            || schema.get("format").and_then(Value::as_str) == Some("password")
            || schema.get("x-sensitive").and_then(Value::as_bool) == Some(true)
    })
}

pub(super) fn readonly(schemas: &[&Value]) -> bool {
    schemas
        .iter()
        .any(|schema| schema.get("readOnly").and_then(Value::as_bool) == Some(true))
}
