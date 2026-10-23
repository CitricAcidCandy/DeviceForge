//! 托管入口仅写有效配置快照，不改写用户保存值及其修订。
mod schema;

use super::{FilePluginConfigurations, storage};
use apk_domain::{Error, Result};
use apk_plugin_sdk::resources::ManagedResources;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub(super) fn path(store: &FilePluginConfigurations, id: &str) -> Result<Option<PathBuf>> {
    let directory = store.deployment_directory(id)?;
    let active = directory.join("resources.json");
    if !active.exists() {
        // 用户根遵循明确的 plugin-configurations/server 布局；自定义旧根不推断仓库。
        let Some(configuration_root) = store.root.parent().filter(|parent| {
            parent
                .file_name()
                .is_some_and(|name| name == "plugin-configurations")
        }) else {
            return Ok(None);
        };
        if store.root.file_name().is_none_or(|name| name != "server") {
            return Ok(None);
        }
        let Some(user_root) = configuration_root.parent() else {
            return Ok(None);
        };
        let tools = user_root.join("tools");
        if !tools.join(".repository").is_dir() {
            return Ok(None);
        }
        let root = std::fs::canonicalize(&tools)
            .map_err(|_| Error::Storage("托管仓库根不可访问".into()))?;
        let descriptor = serde_json::json!({"format_version":1,"release_id":id,"revision":"0".repeat(64),"tools":{},"bindings":[],
            "repository":{"format_version":1,"root":root,"client_id":id}});
        let bytes = serde_json::to_vec(&descriptor)
            .map_err(|_| Error::Storage("仓库描述编码失败".into()))?;
        let directory = storage::checked_directory(&store.root, id, true)?;
        let destination = directory.join(format!("resources-{:x}.json", Sha256::digest(bytes)));
        if !destination.exists() {
            storage::write(&destination, &descriptor)?;
        }
        return Ok(Some(destination));
    }
    let resources = ManagedResources::read(&active)
        .map_err(|_| Error::Invalid("托管工具资源绑定无效".into()))?;
    let immutable = directory
        .join("revisions")
        .join(resources.revision)
        .join("resources.json");
    if !immutable.is_file() {
        return Err(Error::Conflict("发布资源绑定快照缺失".into()));
    }
    Ok(Some(immutable))
}

pub(super) fn effective(
    store: &FilePluginConfigurations,
    id: &str,
    revision: u64,
    original: PathBuf,
    mut values: Value,
) -> Result<PathBuf> {
    let Some(path) = path(store, id)? else {
        return Ok(original);
    };
    let resources =
        ManagedResources::read(&path).map_err(|_| Error::Invalid("托管工具资源绑定无效".into()))?;
    let definition = store.manifest(id)?.configuration;
    for binding in resources
        .bindings
        .iter()
        .filter(|binding| binding.component_id == id)
    {
        let entry = resources
            .entry(&binding.tool_id, &binding.entry)
            .map_err(|_| Error::Invalid("工具资源入口未绑定".into()))?;
        let current = values.pointer(&binding.config_pointer);
        if current
            .and_then(Value::as_str)
            .is_some_and(|value| std::path::Path::new(value).is_absolute())
        {
            continue;
        }
        // 用户保存的相对入口也属于显式覆盖；仅默认值、空值和缺失值使用托管入口。
        if let Some(current) = current
            && !current.is_null()
            && current.as_str().is_none_or(|value| !value.is_empty())
            && definition
                .as_ref()
                .and_then(|value| value.defaults.pointer(&binding.config_pointer))
                != Some(current)
        {
            continue;
        }
        let replacement = Value::String(entry.to_string_lossy().into_owned());
        if let Some(definition) = &definition {
            values = schema::bind(
                &definition.schema,
                &values,
                &binding.config_pointer,
                replacement,
            )?;
        } else {
            set_pointer(&mut values, &binding.config_pointer, replacement)?;
        }
    }
    if let Some(definition) = &definition {
        let validator = jsonschema::validator_for(&definition.schema)
            .map_err(|_| Error::Invalid("插件配置模式无效".into()))?;
        if !validator.is_valid(&values) {
            return Err(Error::Invalid("托管工具绑定后配置不符合声明模式".into()));
        }
    }
    let bytes =
        serde_json::to_vec(&values).map_err(|_| Error::Storage("有效配置序列化失败".into()))?;
    let digest = format!("{:x}", Sha256::digest(bytes));
    let destination = store
        .root
        .join(id)
        .join(format!("effective-{revision}-{digest}.json"));
    if destination.exists() {
        let old: Value = storage::json(&destination)?;
        if old != values {
            return Err(Error::Conflict("有效配置快照摘要冲突".into()));
        }
    } else {
        storage::write(&destination, &values)?;
    }
    Ok(destination)
}

fn set_pointer(value: &mut Value, pointer: &str, replacement: Value) -> Result<()> {
    if !pointer.starts_with('/') {
        return Err(Error::Invalid("工具绑定配置指针无效".into()));
    }
    let parts: Vec<String> = pointer[1..]
        .split('/')
        .map(|part| part.replace("~1", "/").replace("~0", "~"))
        .collect();
    let mut cursor = value;
    for (index, part) in parts.iter().enumerate() {
        if cursor.is_null() {
            *cursor = serde_json::json!({});
        }
        if let Value::Array(items) = cursor {
            let item = part
                .parse::<usize>()
                .ok()
                .filter(|position| position.to_string() == *part)
                .and_then(|position| items.get_mut(position))
                .ok_or_else(|| Error::Invalid("工具绑定数组下标必须引用已有项".into()))?;
            if index + 1 == parts.len() {
                *item = replacement;
                return Ok(());
            }
            cursor = item;
        } else {
            let object = cursor
                .as_object_mut()
                .ok_or_else(|| Error::Invalid("工具绑定配置父节点必须为对象或数组".into()))?;
            if index + 1 == parts.len() {
                object.insert(part.clone(), replacement);
                return Ok(());
            }
            cursor = object.entry(part).or_insert_with(|| serde_json::json!({}));
        }
    }
    Err(Error::Invalid("工具绑定配置指针为空".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pointer_updates_existing_arrays_and_rejects_invalid_indices() {
        let mut value = serde_json::json!({"items":[{"tool":"old"}],"a/b":null});
        set_pointer(&mut value, "/items/0/tool", Value::String("new".into())).unwrap();
        set_pointer(&mut value, "/a~1b/~0tool", Value::Bool(true)).unwrap();
        assert_eq!(
            value.pointer("/items/0/tool"),
            Some(&Value::String("new".into()))
        );
        assert_eq!(value.pointer("/a~1b/~0tool"), Some(&Value::Bool(true)));
        assert!(set_pointer(&mut value, "/items/01/tool", Value::Null).is_err());
        assert!(set_pointer(&mut value, "/items/9/tool", Value::Null).is_err());
    }
}
