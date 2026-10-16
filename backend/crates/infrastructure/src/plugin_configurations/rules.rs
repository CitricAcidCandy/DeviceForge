//! 配置模式编译、合并补丁与敏感值遮蔽，错误不回显原值。
use apk_domain::{Error, Result, plugin_configurations::*};
use serde_json::{Value, json};

pub(super) const MASK: &str = "********";

pub(super) fn definition(
    value: &apk_plugin_sdk::ConfigurationDefinition,
) -> Result<ConfigurationDefinition> {
    let definition: ConfigurationDefinition = serde_json::from_value(
        serde_json::to_value(value).map_err(|_| Error::Invalid("配置声明无法序列化".into()))?,
    )
    .map_err(|_| Error::Invalid("配置声明不符合公开协议".into()))?;
    if definition.version == 0
        || definition.schema.get("type").and_then(Value::as_str) != Some("object")
        || !definition.defaults.is_object()
    {
        return Err(Error::Invalid(
            "配置声明要求正版本、对象模式和对象默认值".into(),
        ));
    }
    if definition.legacy_filename.as_ref().is_some_and(|name| {
        name.is_empty()
            || name.len() > 180
            || name.contains(['/', '\\', ':'])
            || name == "."
            || name == ".."
    }) {
        return Err(Error::Invalid("旧配置文件名必须是不含路径的文件名".into()));
    }
    apk_domain::validate_local_schema(&definition.schema)?;
    let validator = jsonschema::validator_for(&definition.schema)
        .map_err(|_| Error::Invalid("插件配置模式无效".into()))?;
    if !validator.is_valid(&definition.defaults) {
        return Err(Error::Invalid("配置默认值不符合声明模式".into()));
    }
    Ok(definition)
}

pub(super) fn errors(
    definition: &ConfigurationDefinition,
    values: &Value,
) -> Result<Vec<ConfigurationFieldError>> {
    let validator = jsonschema::validator_for(&definition.schema)
        .map_err(|_| Error::Invalid("插件配置模式无效".into()))?;
    Ok(validator
        .iter_errors(values)
        .take(100)
        .map(|error| ConfigurationFieldError {
            path: error.instance_path.to_string(),
            message: "字段不符合插件配置模式".into(),
        })
        .collect())
}

pub(super) fn merge(target: &mut Value, patch: &Value) {
    if let Some(patch) = patch.as_object() {
        if !target.is_object() {
            *target = json!({});
        }
        let target = target.as_object_mut().expect("已转为对象");
        for (name, value) in patch {
            if value.is_null() {
                target.remove(name);
            } else {
                merge(target.entry(name).or_insert(Value::Null), value);
            }
        }
    } else {
        *target = patch.clone();
    }
}

fn sensitive(schema: &Value) -> bool {
    schema.get("writeOnly").and_then(Value::as_bool) == Some(true)
        || schema.get("format").and_then(Value::as_str) == Some("password")
        || schema.get("x-sensitive").and_then(Value::as_bool) == Some(true)
}

fn property<'a>(schema: &'a Value, name: &str) -> &'a Value {
    schema
        .get("properties")
        .and_then(|value| value.get(name))
        .unwrap_or(&schema["additionalProperties"])
}

pub(super) fn mask(values: &mut Value, schema: &Value) {
    if sensitive(schema) {
        if !values.is_null() {
            *values = json!(MASK);
        }
        return;
    }
    if let Some(object) = values.as_object_mut() {
        for (name, value) in object {
            mask(value, property(schema, name));
        }
    } else if let Some(array) = values.as_array_mut() {
        for value in array {
            mask(value, &schema["items"]);
        }
    }
}

pub(super) fn preserve_mask(patch: &mut Value, old: &Value, schema: &Value) {
    if sensitive(schema) && patch.as_str() == Some(MASK) {
        *patch = old.clone();
        return;
    }
    if let Some(object) = patch.as_object_mut() {
        for (name, value) in object {
            preserve_mask(value, &old[name], property(schema, name));
        }
    } else if let Some(array) = patch.as_array_mut() {
        for (index, value) in array.iter_mut().enumerate() {
            preserve_mask(value, &old[index], &schema["items"]);
        }
    }
}

pub(super) fn mask_schema(schema: &mut Value) {
    if sensitive(schema) {
        if let Some(object) = schema.as_object_mut() {
            object.remove("default");
        }
    }
    if let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) {
        for value in properties.values_mut() {
            mask_schema(value);
        }
    }
    if let Some(items) = schema.get_mut("items") {
        mask_schema(items);
    }
    if let Some(additional) = schema.get_mut("additionalProperties") {
        mask_schema(additional);
    }
    for map in ["$defs", "definitions", "patternProperties"] {
        if let Some(values) = schema.get_mut(map).and_then(Value::as_object_mut) {
            for value in values.values_mut() {
                mask_schema(value);
            }
        }
    }
    for group in ["allOf", "anyOf", "oneOf"] {
        if let Some(values) = schema.get_mut(group).and_then(Value::as_array_mut) {
            for value in values {
                mask_schema(value);
            }
        }
    }
}

pub(super) fn readonly_errors(
    old: &Value,
    values: &Value,
    schema: &Value,
) -> Vec<ConfigurationFieldError> {
    fn visit(
        old: &Value,
        values: &Value,
        schema: &Value,
        path: &str,
        output: &mut Vec<ConfigurationFieldError>,
    ) {
        if output.len() >= 100 {
            return;
        }
        if schema.get("readOnly").and_then(Value::as_bool) == Some(true) && old != values {
            output.push(ConfigurationFieldError {
                path: path.into(),
                message: "只读配置字段不能修改".into(),
            });
            return;
        }
        if old.is_object() || values.is_object() {
            let names: std::collections::BTreeSet<_> = old
                .as_object()
                .into_iter()
                .flat_map(|value| value.keys())
                .chain(
                    values
                        .as_object()
                        .into_iter()
                        .flat_map(|value| value.keys()),
                )
                .collect();
            for name in names {
                visit(
                    &old[name],
                    &values[name],
                    property(schema, name),
                    &format!("{path}/{}", name.replace('~', "~0").replace('/', "~1")),
                    output,
                );
            }
        } else if old.is_array() || values.is_array() {
            let length = old
                .as_array()
                .map_or(0, Vec::len)
                .max(values.as_array().map_or(0, Vec::len));
            for index in 0..length {
                visit(
                    &old[index],
                    &values[index],
                    &schema["items"],
                    &format!("{path}/{index}"),
                    output,
                );
            }
        }
    }
    let mut output = Vec::new();
    visit(old, values, schema, "", &mut output);
    output
}
