//! 托管入口仅写有效配置快照，不改写用户保存值及其修订。
use super::{FilePluginConfigurations, storage};
use apk_domain::{Error, Result};
use apk_plugin_sdk::resources::ManagedResources;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub(super) fn path(store: &FilePluginConfigurations, id: &str) -> Result<Option<PathBuf>> {
    let directory = store.deployment_directory(id)?;
    let active = directory.join("resources.json");
    if !active.exists() { return Ok(None); }
    let resources = ManagedResources::read(&active)
        .map_err(|_| Error::Invalid("托管工具资源绑定无效".into()))?;
    let immutable = directory.join("revisions").join(resources.revision).join("resources.json");
    if !immutable.is_file() { return Err(Error::Conflict("发布资源绑定快照缺失".into())); }
    Ok(Some(immutable))
}

pub(super) fn effective(
    store: &FilePluginConfigurations,
    id: &str,
    revision: u64,
    original: PathBuf,
    mut values: Value,
) -> Result<PathBuf> {
    let Some(path) = path(store, id)? else { return Ok(original); };
    let resources = ManagedResources::read(&path)
        .map_err(|_| Error::Invalid("托管工具资源绑定无效".into()))?;
    for binding in resources.bindings.iter().filter(|binding| binding.component_id == id) {
        let entry = resources.entry(&binding.tool_id, &binding.entry)
            .map_err(|_| Error::Invalid("工具资源入口未绑定".into()))?;
        let current = values.pointer(&binding.config_pointer);
        if current.and_then(Value::as_str).is_some_and(|value| std::path::Path::new(value).is_absolute()) {
            continue;
        }
        set_pointer(&mut values, &binding.config_pointer, Value::String(entry.to_string_lossy().into_owned()))?;
    }
    let bytes = serde_json::to_vec(&values).map_err(|_| Error::Storage("有效配置序列化失败".into()))?;
    let digest = format!("{:x}", Sha256::digest(bytes));
    let destination = store.root.join(id).join(format!("effective-{revision}-{digest}.json"));
    if destination.exists() {
        let old: Value = storage::json(&destination)?;
        if old != values { return Err(Error::Conflict("有效配置快照摘要冲突".into())); }
    } else { storage::write(&destination, &values)?; }
    Ok(destination)
}

fn set_pointer(value: &mut Value, pointer: &str, replacement: Value) -> Result<()> {
    if !pointer.starts_with('/') { return Err(Error::Invalid("工具绑定配置指针无效".into())); }
    let parts: Vec<String> = pointer[1..].split('/').map(|part| part.replace("~1", "/").replace("~0", "~")).collect();
    let mut cursor = value;
    for (index, part) in parts.iter().enumerate() {
        if cursor.is_null() { *cursor = serde_json::json!({}); }
        let object = cursor.as_object_mut().ok_or_else(|| Error::Invalid("工具绑定配置父节点必须为对象".into()))?;
        if index + 1 == parts.len() { object.insert(part.clone(), replacement); return Ok(()); }
        cursor = object.entry(part).or_insert_with(|| serde_json::json!({}));
    }
    Err(Error::Invalid("工具绑定配置指针为空".into()))
}
