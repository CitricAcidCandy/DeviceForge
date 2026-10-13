mod reading;

use crate::{Error, Result, operation};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
};

pub(crate) const CONFIG_LIMIT: usize = 65_536;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    format_version: u32,
    #[serde(deserialize_with = "profiles")]
    profiles: BTreeMap<String, Profile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Profile {
    pub executable: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub directory: Option<PathBuf>,
    resource_scope: ResourceScope,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ResourceScope {
    DirectProcess,
}

fn profiles<'de, Decoder: serde::Deserializer<'de>>(
    decoder: Decoder,
) -> std::result::Result<BTreeMap<String, Profile>, Decoder::Error> {
    struct UniqueProfiles;
    impl<'de> serde::de::Visitor<'de> for UniqueProfiles {
        type Value = BTreeMap<String, Profile>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("最多32项且名称不重复的终端profile对象")
        }
        fn visit_map<Map: serde::de::MapAccess<'de>>(
            self,
            mut map: Map,
        ) -> std::result::Result<Self::Value, Map::Error> {
            let mut profiles = BTreeMap::new();
            while let Some((name, profile)) = map.next_entry::<String, Profile>()? {
                if profiles.len() >= 32 || profiles.insert(name, profile).is_some() {
                    return Err(serde::de::Error::custom("终端profile重复或超过32项"));
                }
            }
            Ok(profiles)
        }
    }
    decoder.deserialize_map(UniqueProfiles)
}

pub(super) fn absolute(path: &Path) -> Result<()> {
    let text = path
        .to_str()
        .ok_or(Error::Configuration("配置路径须为UTF-8"))?;
    if text.is_empty()
        || text.len() > 4096
        || text.chars().any(char::is_control)
        || !path.is_absolute()
        || text.split(['/', '\\']).any(|part| part == "..")
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(Error::Configuration("路径须为无父路径的绝对路径"));
    }
    Ok(())
}

fn program(value: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(Error::Configuration("程序入口为空、超限或含控制符"));
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return absolute(path);
    }
    if value.starts_with('-')
        || value.contains(['/', '\\', ':'])
        || value.chars().any(char::is_whitespace)
        || path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err(Error::Configuration("程序入口须为绝对路径或单一程序名"));
    }
    Ok(())
}

impl Config {
    pub(crate) fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > CONFIG_LIMIT {
            return Err(Error::Configuration("部署配置超过65536字节"));
        }
        let config: Self = serde_json::from_slice(bytes)
            .map_err(|_| Error::Configuration("部署JSON或字段不符合严格格式"))?;
        if config.format_version != 1 || config.profiles.is_empty() {
            return Err(Error::Configuration("配置须为版本1且至少包含一个profile"));
        }
        for (name, profile) in &config.profiles {
            if !operation::name(name) {
                return Err(Error::Configuration("profile名称不符合小写标识格式"));
            }
            program(&profile.executable)?;
            if profile.args.len() > 64
                || profile
                    .args
                    .iter()
                    .any(|arg| arg.len() > 4096 || arg.chars().any(char::is_control))
                || profile.args.iter().map(String::len).sum::<usize>() > 16_384
            {
                return Err(Error::Configuration("固定argv数量、字节或控制符超限"));
            }
            if let Some(directory) = &profile.directory {
                absolute(directory)?;
            }
            match profile.resource_scope {
                ResourceScope::DirectProcess => {}
            }
        }
        Ok(config)
    }

    pub(crate) fn profile(&self, name: &str) -> Result<&Profile> {
        self.profiles
            .get(name)
            .ok_or(Error::Configuration("请求的profile未由部署者配置"))
    }
}

#[cfg(test)]
mod tests;
