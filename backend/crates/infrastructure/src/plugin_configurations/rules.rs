//! 配置模式编译、合并补丁与敏感值遮蔽，错误不回显原值。
use super::annotations;
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
    annotations::validate(&definition.schema)?;
    let validator = jsonschema::validator_for(&definition.schema)
        .map_err(|_| Error::Invalid("插件配置模式无效".into()))?;
    // 默认配置是初始草稿，可缺少用户必填输入；实际保存及运行仍验证完整模式。
    if validator.iter_errors(&definition.defaults).any(|error| {
        !matches!(
            error.kind,
            jsonschema::error::ValidationErrorKind::Required { .. }
        )
    }) {
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

pub(super) fn mask(values: &mut Value, schema: &Value) {
    mask_at(values, schema, &[schema]);
}

pub(super) fn sensitive_paths(values: &Value, schema: &Value) -> Vec<String> {
    fn visit(values: &Value, root: &Value, seeds: &[&Value], path: &str, output: &mut Vec<String>) {
        let schemas = annotations::expanded(root, seeds);
        if annotations::sensitive(&schemas) {
            output.push(path.into());
        } else if let Some(object) = values.as_object() {
            for (name, value) in object {
                visit(
                    value,
                    root,
                    &annotations::property(&schemas, name),
                    &format!("{path}/{}", name.replace('~', "~0").replace('/', "~1")),
                    output,
                );
            }
        } else if let Some(array) = values.as_array() {
            for (index, value) in array.iter().enumerate() {
                visit(
                    value,
                    root,
                    &annotations::item(&schemas, index),
                    &format!("{path}/{index}"),
                    output,
                );
            }
        }
    }
    let mut output = Vec::new();
    visit(values, schema, &[schema], "", &mut output);
    output
}

pub(super) fn mask_paths(values: &mut Value, paths: &[String]) {
    for path in paths {
        if let Some(value) = values.pointer_mut(path)
            && !value.is_null()
        {
            *value = json!(MASK);
        }
    }
}

pub(super) fn preserve_paths(patch: &mut Value, old: &Value, paths: &[String]) {
    for path in paths {
        if let Some(value) = patch.pointer_mut(path)
            && value.as_str() == Some(MASK)
        {
            *value = old.pointer(path).cloned().unwrap_or(Value::Null);
        }
    }
}

fn mask_at(values: &mut Value, root: &Value, seeds: &[&Value]) {
    let schemas = annotations::expanded(root, seeds);
    if annotations::sensitive(&schemas) {
        if !values.is_null() {
            *values = json!(MASK);
        }
        return;
    }
    if let Some(object) = values.as_object_mut() {
        for (name, value) in object {
            mask_at(value, root, &annotations::property(&schemas, name));
        }
    } else if let Some(array) = values.as_array_mut() {
        for (index, value) in array.iter_mut().enumerate() {
            mask_at(value, root, &annotations::item(&schemas, index));
        }
    }
}

pub(super) fn preserve_mask(patch: &mut Value, old: &Value, schema: &Value) {
    preserve_at(patch, old, schema, &[schema]);
}

fn preserve_at(patch: &mut Value, old: &Value, root: &Value, seeds: &[&Value]) {
    let schemas = annotations::expanded(root, seeds);
    if annotations::sensitive(&schemas) && patch.as_str() == Some(MASK) {
        *patch = old.clone();
        return;
    }
    if let Some(object) = patch.as_object_mut() {
        for (name, value) in object {
            preserve_at(
                value,
                &old[name],
                root,
                &annotations::property(&schemas, name),
            );
        }
    } else if let Some(array) = patch.as_array_mut() {
        for (index, value) in array.iter_mut().enumerate() {
            preserve_at(
                value,
                &old[index],
                root,
                &annotations::item(&schemas, index),
            );
        }
    }
}

pub(super) fn mask_schema(schema: &mut Value) {
    fn visit(schema: &mut Value, original: &Value, root: &Value) {
        let schemas = annotations::expanded(root, &[original]);
        if let Some(object) = schema.as_object_mut() {
            if annotations::sensitive(&schemas) {
                object.remove("default");
                object.remove("examples");
            } else {
                if let Some(default) = object.get_mut("default") {
                    mask_at(default, root, &[original]);
                }
                if let Some(examples) = object.get_mut("examples").and_then(Value::as_array_mut) {
                    for value in examples {
                        mask_at(value, root, &[original]);
                    }
                }
            }
            // 任意层级的 schema default 都可能含嵌套敏感值，不能只删除叶子默认值。
            for map in [
                "properties",
                "patternProperties",
                "$defs",
                "definitions",
                "dependentSchemas",
                "dependencies",
            ] {
                if let Some(values) = object.get_mut(map).and_then(Value::as_object_mut) {
                    for (name, value) in values {
                        visit(value, &original[map][name], root);
                    }
                }
            }
            for keyword in [
                "allOf",
                "anyOf",
                "oneOf",
                "prefixItems",
                "items",
                "additionalItems",
                "additionalProperties",
                "unevaluatedProperties",
                "unevaluatedItems",
                "contains",
                "if",
                "then",
                "else",
                "not",
                "propertyNames",
            ] {
                if let Some(value) = object.get_mut(keyword) {
                    visit(value, &original[keyword], root);
                }
            }
        } else if let Some(values) = schema.as_array_mut() {
            for (index, value) in values.iter_mut().enumerate() {
                visit(value, &original[index], root);
            }
        }
    }
    let original = schema.clone();
    visit(schema, &original, &original);
}

pub(super) fn readonly_errors(
    old: &Value,
    values: &Value,
    schema: &Value,
) -> Vec<ConfigurationFieldError> {
    fn visit(
        old: &Value,
        values: &Value,
        root: &Value,
        seeds: &[&Value],
        path: &str,
        output: &mut Vec<ConfigurationFieldError>,
    ) {
        if output.len() >= 100 {
            return;
        }
        let schemas = annotations::expanded(root, seeds);
        if annotations::readonly(&schemas) && old != values {
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
                    root,
                    &annotations::property(&schemas, name),
                    &format!("{path}/{}", name.replace('~', "~0").replace('/', "~1")),
                    output,
                );
            }
        }
        if old.is_array() || values.is_array() {
            let length = old
                .as_array()
                .map_or(0, Vec::len)
                .max(values.as_array().map_or(0, Vec::len));
            for index in 0..length {
                visit(
                    &old[index],
                    &values[index],
                    root,
                    &annotations::item(&schemas, index),
                    &format!("{path}/{index}"),
                    output,
                );
            }
        }
    }
    let mut output = Vec::new();
    visit(old, values, schema, &[schema], "", &mut output);
    output
}
