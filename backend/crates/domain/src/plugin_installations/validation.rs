//! 发布声明的纯规则；文件和网络适配器重复执行相同门禁。
use super::*;
use crate::{Error, plugins::plugin_id};
use std::collections::HashSet;

pub fn digest(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::Invalid("发布资源摘要必须为小写 SHA-256".into()));
    }
    Ok(())
}

pub fn version(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 100
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-+".contains(&b))
        || value == "."
        || value == ".."
    {
        return Err(Error::Invalid("发布版本必须为有界版本标识".into()));
    }
    Ok(())
}

pub fn relative(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 512
        || value.contains(['\\', ':', '\0', '?', '#', '%'])
        || value.starts_with('/')
    {
        return Err(Error::Invalid("发布资源必须为有界相对路径".into()));
    }
    for part in value.split('/') {
        let upper = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "<>\"|?*".contains(c))
            || ["CON", "PRN", "AUX", "NUL"].contains(&upper.as_str())
            || (upper.len() == 4
                && (upper.starts_with("COM") || upper.starts_with("LPT"))
                && upper.ends_with(['1', '2', '3', '4', '5', '6', '7', '8', '9']))
        {
            return Err(Error::Invalid("发布路径含越界或系统保留片段".into()));
        }
    }
    Ok(())
}

fn pointer(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 512
        || !value.starts_with('/')
        || value.chars().any(char::is_control)
    {
        return Err(Error::Invalid("配置绑定须为非空 JSON Pointer".into()));
    }
    let bytes = value.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'~' && !matches!(bytes.get(index + 1), Some(b'0' | b'1')) {
            return Err(Error::Invalid("配置绑定 JSON Pointer 转义无效".into()));
        }
    }
    Ok(())
}

fn resource(platform: &str, path: &str, sha256: &str, size: u64) -> Result<()> {
    if platform != "any"
        && (platform.len() > 40
            || !platform.contains('-')
            || !platform
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
    {
        return Err(Error::Invalid("发布平台标识无效".into()));
    }
    relative(path)?;
    digest(sha256)?;
    if size == 0 || size > RELEASE_RESOURCE_LIMIT {
        return Err(Error::TooLarge);
    }
    Ok(())
}

impl ReleaseManifest {
    pub fn validate(&self) -> Result<()> {
        if !matches!(self.format_version, 1 | 2) || self.host_api_version != 2 {
            return Err(Error::Invalid("发布格式或宿主 API 版本不受支持".into()));
        }
        if self.format_version == 1 && self.dependencies.is_some() {
            return Err(Error::Invalid("依赖声明需要发布格式第二版".into()));
        }
        if let Some(dependencies) = &self.dependencies {
            dependencies.validate().map_err(Error::Invalid)?;
            for binding in dependencies
                .dependencies
                .iter()
                .flat_map(|dependency| &dependency.bindings)
            {
                if !self
                    .components
                    .iter()
                    .any(|component| component.id == binding.component_id)
                {
                    return Err(Error::Invalid("完整发布的依赖绑定必须指向声明组件".into()));
                }
            }
        }
        plugin_id(&self.id)?;
        version(&self.version)?;
        if self.name.trim().is_empty()
            || self.name.len() > 200
            || self.description.trim().is_empty()
            || self.description.len() > 16_384
            || self.name.chars().any(char::is_control)
        {
            return Err(Error::Invalid("发布名称或描述无效".into()));
        }
        if self.components.is_empty()
            || self.components.len() > 32
            || self.tools.len() > 128
            || self.requirements.len() > 128
        {
            return Err(Error::TooLarge);
        }
        let mut ids = HashSet::new();
        for component in &self.components {
            plugin_id(&component.id)?;
            version(&component.version)?;
            if !ids.insert(&component.id) {
                return Err(Error::Invalid("发布组件 ID 重复".into()));
            }
            if component.variants.is_empty() || component.variants.len() > 32 {
                return Err(Error::TooLarge);
            }
            let mut platforms = HashSet::new();
            for variant in &component.variants {
                resource(
                    &variant.platform,
                    &variant.path,
                    &variant.sha256,
                    variant.size,
                )?;
                if variant.format == ResourceFormat::File || !platforms.insert(&variant.platform) {
                    return Err(Error::Invalid("组件归档格式或平台重复".into()));
                }
            }
        }
        let mut tools = HashSet::new();
        let mut targets = HashSet::new();
        for tool in &self.tools {
            plugin_id(&tool.id)?;
            version(&tool.version)?;
            if !tools.insert(&tool.id) || tool.variants.len() > 32 || tool.bindings.len() > 128 {
                return Err(Error::Invalid("工具重复或声明过多".into()));
            }
            if tool.variants.is_empty() && tool.required {
                return Err(Error::Invalid("必需工具没有资源变体".into()));
            }
            let mut platforms = HashSet::new();
            for variant in &tool.variants {
                resource(
                    &variant.platform,
                    &variant.path,
                    &variant.sha256,
                    variant.size,
                )?;
                if !platforms.insert(&variant.platform)
                    || variant.entries.is_empty()
                    || variant.entries.len() > 128
                {
                    return Err(Error::Invalid("工具平台重复或入口无效".into()));
                }
                for (key, path) in &variant.entries {
                    plugin_id(key)?;
                    relative(path)?;
                    if variant.format == ResourceFormat::File && path != "payload" {
                        return Err(Error::Invalid("单文件工具入口必须为 payload".into()));
                    }
                }
            }
            for binding in &tool.bindings {
                if !ids.contains(&binding.component_id)
                    || !targets.insert((&binding.component_id, &binding.config_pointer))
                {
                    return Err(Error::Invalid("工具配置绑定组件未知或重复".into()));
                }
                pointer(&binding.config_pointer)?;
                if !tool
                    .variants
                    .iter()
                    .all(|variant| variant.entries.contains_key(&binding.entry))
                {
                    return Err(Error::Invalid("工具绑定引用未声明资源键".into()));
                }
            }
        }
        for requirement in &self.requirements {
            if !ids.contains(&requirement.component_id)
                || requirement.title.trim().is_empty()
                || requirement.title.len() > 200
                || requirement.description.len() > 4096
            {
                return Err(Error::Invalid("用户输入声明无效".into()));
            }
            pointer(&requirement.config_pointer)?;
            if requirement.any_of.len() > 16 {
                return Err(Error::Invalid("用户输入候选配置指针超过16项".into()));
            }
            let mut pointers = HashSet::from([requirement.config_pointer.as_str()]);
            for candidate in &requirement.any_of {
                pointer(candidate)?;
                if !pointers.insert(candidate.as_str()) {
                    return Err(Error::Invalid("用户输入候选配置指针重复".into()));
                }
            }
        }
        if serde_json::to_vec(self)
            .map_err(|_| Error::Invalid("发布声明无法编码".into()))?
            .len()
            > RELEASE_MANIFEST_LIMIT
        {
            return Err(Error::TooLarge);
        }
        Ok(())
    }
}

pub use digest as validate_release_digest;
pub use relative as validate_release_path;
