//! 声明验证保持纯函数，实际路径、URL 与进程检查仍由适配器执行。
use crate::*;
use std::collections::{BTreeMap, BTreeSet};

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 99
        && !value.starts_with("builtin.")
        && value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

fn relative(value: &str, dot: bool) -> bool {
    (dot && value == ".")
        || (!value.is_empty()
            && value.len() <= 512
            && !value.starts_with('/')
            && !value.contains(['\\', ':', '\0', '?', '#'])
            && value.split('/').all(|part| {
                !part.is_empty()
                    && part != "."
                    && part != ".."
                    && !part.chars().any(char::is_control)
            }))
}

pub fn compatible_version(requirement: &str, actual: &str) -> bool {
    if actual.is_empty() {
        return false;
    }
    if requirement == "*" {
        return true;
    }
    if let (Ok(range), Ok(version)) = (
        semver::VersionReq::parse(requirement),
        semver::Version::parse(actual),
    ) {
        return range.matches(&version);
    }
    requirement.strip_prefix('=').unwrap_or(requirement).trim() == actual
}

pub fn probe_version(probe: &VersionProbe, output: &str) -> Option<String> {
    if output.len() > 65_536 {
        return None;
    }
    regex::Regex::new(&probe.pattern)
        .ok()?
        .captures(output)?
        .get(1)
        .map(|value| value.as_str().to_owned())
}

impl DependencyManifest {
    pub fn validate(&self) -> Result<(), String> {
        if self.format_version != 1 || self.dependencies.len() > 128 {
            return Err("依赖描述版本不受支持或数量超限".into());
        }
        let mut ids = BTreeSet::new();
        for dependency in &self.dependencies {
            if !identifier(&dependency.id) || !ids.insert(dependency.id.as_str()) {
                return Err("依赖标识无效或重复".into());
            }
            dependency.validate()?;
        }
        let graph: BTreeMap<_, _> = self
            .dependencies
            .iter()
            .map(|item| (item.id.as_str(), item.requires.as_slice()))
            .collect();
        fn visit<'a>(
            id: &'a str,
            graph: &BTreeMap<&'a str, &'a [String]>,
            active: &mut BTreeSet<&'a str>,
            done: &mut BTreeSet<&'a str>,
        ) -> Result<(), String> {
            if done.contains(id) {
                return Ok(());
            }
            if !active.insert(id) {
                return Err("配套依赖存在循环".into());
            }
            for child in graph.get(id).ok_or("配套依赖未声明")?.iter() {
                visit(child, graph, active, done)?;
            }
            active.remove(id);
            done.insert(id);
            Ok(())
        }
        let mut done = BTreeSet::new();
        for id in graph.keys() {
            visit(id, &graph, &mut BTreeSet::new(), &mut done)?;
        }
        Ok(())
    }
}

impl Dependency {
    fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty()
            || self.name.len() > 200
            || self.version_requirement.is_empty()
            || self.version_requirement.len() > 128
            || self.entries.is_empty()
            || self.entries.len() > 64
            || self.discovery.len() > 32
            || self.sources.len() > 32
            || self.bindings.len() > 64
            || self.requires.len() > 128
        {
            return Err("依赖名称、版本范围、入口或规则数量无效".into());
        }
        let entries: BTreeSet<_> = self.entries.iter().map(String::as_str).collect();
        if entries.len() != self.entries.len() || entries.iter().any(|entry| !identifier(entry)) {
            return Err("依赖入口标识无效或重复".into());
        }
        if semver::VersionReq::parse(&self.version_requirement).is_err()
            && !self
                .version_requirement
                .strip_prefix('=')
                .unwrap_or(&self.version_requirement)
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-+".contains(&b))
        {
            return Err("依赖兼容范围无效".into());
        }
        for rule in &self.discovery {
            let valid_value = match rule.kind {
                DiscoveryKind::Environment => {
                    !rule.value.is_empty()
                        && rule.value.len() <= 128
                        && rule
                            .value
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                }
                DiscoveryKind::Path => {
                    !rule.value.is_empty()
                        && rule.value.len() <= 128
                        && !rule.value.contains(['/', '\\', ':'])
                        && !rule.value.starts_with('-')
                        && !rule.value.chars().any(char::is_whitespace)
                }
                DiscoveryKind::UserDirectory => relative(&rule.value, true),
            };
            if !valid_value
                || rule.entries.is_empty()
                || rule.entries.len() > 64
                || rule
                    .entries
                    .iter()
                    .any(|(key, path)| !entries.contains(key.as_str()) || !relative(path, true))
            {
                return Err("依赖发现规则含无效变量、程序或相对位置".into());
            }
        }
        if let Some(probe) = &self.probe
            && (!entries.contains(probe.entry.as_str())
                || probe.args.len() > 32
                || probe
                    .args
                    .iter()
                    .any(|arg| arg.len() > 4096 || arg.contains('\0'))
                || probe.pattern.len() > 2048
                || !(1..=10_000).contains(&probe.timeout_ms)
                || regex::Regex::new(&probe.pattern).map_or(true, |regex| regex.captures_len() < 2))
        {
            return Err("依赖版本探测规则无效".into());
        }
        for source in &self.sources {
            if source.platform.is_empty()
                || source.platform.len() > 40
                || !source
                    .platform
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                || source.version.is_empty()
                || ["unresolved", ".", ".."].contains(&source.version.as_str())
                || source.version.len() > 100
                || !source
                    .version
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-+".contains(&b))
                || !compatible_version(&self.version_requirement, &source.version)
                || source.size == 0
                || source.size > 2 * 1024 * 1024 * 1024
                || source.sha256.len() != 64
                || !source
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || source.url.len() > 2048
                || source.url.chars().any(char::is_control)
                || !(source.url.starts_with("https://")
                    || (source.kind == SourceKind::Market
                        && (source.url.starts_with("http://") || relative(&source.url, false))))
                || source.entries.len() > 64
                || source.entries.keys().any(|entry| !identifier(entry))
                || entries.iter().any(|key| !source.entries.contains_key(*key))
                || source.entries.values().any(|path| !relative(path, false))
            {
                return Err("依赖下载来源的版本、摘要、大小或入口无效".into());
            }
        }
        for binding in &self.bindings {
            if (!binding.component_id.is_empty() && !identifier(&binding.component_id))
                || !entries.contains(binding.entry.as_str())
                || !binding.config_pointer.starts_with('/')
                || binding.config_pointer.len() > 512
                || binding.config_pointer.chars().any(char::is_control)
                || binding
                    .config_pointer
                    .as_bytes()
                    .windows(2)
                    .any(|pair| pair[0] == b'~' && !b"01".contains(&pair[1]))
                || binding.config_pointer.ends_with('~')
            {
                return Err("依赖配置绑定无效".into());
            }
        }
        Ok(())
    }
}
