//! 发布清单最后落目录前，核对身份与所有不可变资源；不执行插件。
use crate::{MarketEntry, Store, store::StoreError};
use apk_domain::plugin_installations::{RELEASE_MANIFEST_LIMIT, ReleaseManifest};
use deviceforge_plugin_dependencies::SourceKind;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Read};

pub(crate) fn validate(
    store: &Store,
    entry: &MarketEntry,
    market_authority: Option<&str>,
) -> Result<(), StoreError> {
    if entry.details.get("release_format_version").is_none()
        && entry.details.get("host_api_version").is_none()
    {
        return Ok(());
    }
    let format_version = entry
        .details
        .get("release_format_version")
        .and_then(serde_json::Value::as_u64);
    if !matches!(format_version, Some(1 | 2))
        || entry
            .details
            .get("host_api_version")
            .and_then(serde_json::Value::as_u64)
            != Some(2)
    {
        return Err(invalid("完整发布格式或宿主 API 版本不受支持"));
    }
    if entry.kind != crate::ResourceKind::Plugin {
        return Err(invalid("完整发布必须使用插件市场条目"));
    }
    let digest = entry
        .resource_id
        .as_deref()
        .ok_or_else(|| invalid("完整发布必须引用清单资源"))?;
    let resource = store.resource(digest)?;
    if resource.sha256 != digest || resource.size > RELEASE_MANIFEST_LIMIT as u64 {
        return Err(invalid("发布清单资源大小或摘要身份无效"));
    }
    let mut bytes = Vec::new();
    fs::File::open(store.resource_path(&resource)?)?
        .take(RELEASE_MANIFEST_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > RELEASE_MANIFEST_LIMIT || bytes.len() as u64 != resource.size {
        return Err(invalid("发布清单文件大小不符"));
    }
    if format!("{:x}", Sha256::digest(&bytes)) != digest {
        return Err(invalid("发布清单资源摘要不符"));
    }
    let manifest: ReleaseManifest =
        serde_json::from_slice(&bytes).map_err(|_| invalid("发布清单 JSON 无效"))?;
    manifest
        .validate()
        .map_err(|_| invalid("发布清单规则校验失败"))?;
    if Some(u64::from(manifest.format_version)) != format_version
        || manifest.host_api_version != 2
        || manifest.id != entry.id
        || manifest.version != entry.version
        || manifest.name != entry.name
    {
        return Err(invalid("发布清单与市场条目身份不一致"));
    }
    let mut verified = HashSet::new();
    for (path, digest, size) in manifest
        .components
        .iter()
        .flat_map(|component| {
            component
                .variants
                .iter()
                .map(|variant| (&variant.path, &variant.sha256, variant.size))
        })
        .chain(manifest.tools.iter().flat_map(|tool| {
            tool.variants
                .iter()
                .map(|variant| (&variant.path, &variant.sha256, variant.size))
        }))
    {
        // 同一资源服务下直接用摘要寻址；清单不引用任意服务器路径。
        if path != digest {
            return Err(invalid("在线发布资源路径必须为资源服务摘要"));
        }
        verify_resource(store, digest, size, &mut verified)?;
    }
    if let Some(dependencies) = &manifest.dependencies {
        for source in dependencies
            .dependencies
            .iter()
            .flat_map(|item| &item.sources)
        {
            crate::dependency_sources::validate(source, market_authority)?;
            if source.kind == SourceKind::Official {
                // 官方来源只核完整固定元数据，不要求上传第三方原包，也不远端抓取。
                continue;
            }
            let digest = source.sha256.as_str();
            verify_resource(store, digest, source.size, &mut verified)?;
        }
    }
    Ok(())
}

fn verify_resource<'a>(
    store: &Store,
    digest: &'a str,
    size: u64,
    verified: &mut HashSet<(&'a str, u64)>,
) -> Result<(), StoreError> {
    // 多个组件、工具与依赖复用同一内容，每组摘要和长度只读取一次。
    if !verified.insert((digest, size)) {
        return Ok(());
    }
    let resource = store.resource(digest)?;
    let file = fs::File::open(store.resource_path(&resource)?)
        .map_err(|_| invalid("完整发布缺少组件或工具资源文件"))?;
    let metadata = file.metadata()?;
    if resource.sha256 != digest
        || resource.size != size
        || !metadata.is_file()
        || metadata.len() != size
    {
        return Err(invalid("完整发布缺少匹配的组件或工具资源"));
    }
    // 有界流式复核真实字节，避免同长度损坏绕过闭包检查或整包进入内存。
    let mut reader = file.take(size + 1);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut actual_size = 0_u64;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        actual_size += count as u64;
        hasher.update(&buffer[..count]);
    }
    if actual_size != size || format!("{:x}", hasher.finalize()) != digest {
        return Err(invalid("完整发布组件或工具资源摘要或长度不符"));
    }
    Ok(())
}

fn invalid(message: &str) -> StoreError {
    StoreError::Metadata(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};

    fn publish_blob(store: &Store, bytes: &[u8]) -> String {
        let digest = format!("{:x}", Sha256::digest(bytes));
        let temporary = store.temp_path();
        fs::write(&temporary, bytes).unwrap();
        store
            .publish_blob(
                &temporary,
                "resource.bin",
                "application/octet-stream",
                "resource",
                bytes.len() as u64,
                &digest,
            )
            .unwrap();
        digest
    }
    fn entry(store: &Store, manifest: &Value) -> MarketEntry {
        let digest = publish_blob(store, &serde_json::to_vec(manifest).unwrap());
        serde_json::from_value(json!({"metadata_version":1,"id":"third-party","kind":"plugin","name":"第三方功能","version":"1.0.0","summary":"完整发布","description":"发布测试","applies_to":["deviceforge"],"supports_mcp":"none","supports_agent":false,"restart_policy":"plugin_reload","resource_id":digest,"details":{"release_format_version":1,"host_api_version":2}})).unwrap()
    }
    #[test]
    fn complete_release_requires_resources_and_retains_identity_after_removal() {
        let temporary = tempfile::tempdir().unwrap();
        let store = Store::open(temporary.path()).unwrap();
        let bytes = b"portable component bytes";
        let digest = format!("{:x}", Sha256::digest(bytes));
        let mut manifest = json!({"format_version":1,"host_api_version":2,"id":"third-party","version":"1.0.0","name":"第三方功能","description":"完整功能发布","components":[{"id":"third-party","kind":"server","version":"1.0.0","variants":[{"platform":"win32-x64","path":digest,"sha256":digest,"size":bytes.len(),"format":"zip"}]}]});
        let first = entry(&store, &manifest);
        assert!(store.insert_market_entry(&first).is_err());
        publish_blob(&store, bytes);
        store.insert_market_entry(&first).unwrap();
        store.remove_market_entry("third-party", "1.0.0").unwrap();
        manifest["description"] = json!("内容已被改写");
        let changed = entry(&store, &manifest);
        assert!(matches!(
            store.insert_market_entry(&changed),
            Err(StoreError::Conflict)
        ));
        store.insert_market_entry(&first).unwrap();
    }
}
