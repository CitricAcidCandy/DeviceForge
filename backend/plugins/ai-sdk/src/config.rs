use crate::model::{NODE_VERSION, PROFILE, SDK_VERSION, valid_project};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use tokio::io::AsyncReadExt;

pub const CONFIG_LIMIT: u64 = 65_536;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub format_version: u32,
    pub profile: String,
    pub node_executable: PathBuf,
    pub node_version: String,
    pub sdk_entry: PathBuf,
    pub sdk_version: String,
    pub cli_executable: PathBuf,
    pub cli_version: String,
    pub projects: BTreeMap<String, PathBuf>,
    pub state_root: PathBuf,
    pub codex_home: PathBuf,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    #[serde(default)]
    pub thread_options: BTreeMap<String, Value>,
}

fn choice(value: &Value, choices: &[&str]) -> bool {
    value.as_str().is_some_and(|text| choices.contains(&text))
}

fn valid_thread_option(name: &str, value: &Value) -> bool {
    match name {
        "model" | "threadSource" => value.as_str().is_some_and(|text| {
            !text.trim().is_empty() && text.len() <= 128 && !text.contains('\0')
        }),
        "sandboxMode" => choice(
            value,
            &["read-only", "workspace-write", "danger-full-access"],
        ),
        "approvalPolicy" => choice(value, &["never", "on-request", "on-failure", "untrusted"]),
        "modelReasoningEffort" => choice(
            value,
            &[
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
                "ultra",
                "persistent",
            ],
        ),
        "webSearchMode" => choice(value, &["disabled", "cached", "live"]),
        "skipGitRepoCheck" | "networkAccessEnabled" | "webSearchEnabled" => value.is_boolean(),
        _ => false,
    }
}

impl Config {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() as u64 > CONFIG_LIMIT {
            return Err("SDK部署配置超过64KiB".into());
        }
        let config: Self = serde_json::from_slice(bytes).map_err(|_| "SDK部署配置无效")?;
        if config.format_version != 1
            || config.profile != PROFILE
            || config.sdk_version != SDK_VERSION
            || config.cli_version != SDK_VERSION
            || config.node_version != NODE_VERSION
        {
            return Err("SDK部署版本不符合固定资格档案".into());
        }
        for path in [
            &config.node_executable,
            &config.sdk_entry,
            &config.cli_executable,
            &config.state_root,
            &config.codex_home,
        ] {
            if !path.is_absolute() || path.as_os_str().to_string_lossy().contains('\0') {
                return Err("SDK部署入口与目录须为绝对路径".into());
            }
        }
        if config.state_root == config.codex_home
            || config.state_root.starts_with(&config.codex_home)
            || config.codex_home.starts_with(&config.state_root)
        {
            return Err("SDK资格目录与提供者历史须独立".into());
        }
        if config.projects.is_empty()
            || config.projects.len() > 64
            || config
                .projects
                .iter()
                .any(|(project, root)| !valid_project(project) || !root.is_absolute())
        {
            return Err("SDK部署项目映射无效".into());
        }
        if config.environment.len() > 64
            || config.environment.iter().any(|(name, value)| {
                name.is_empty()
                    || name.len() > 128
                    || name.eq_ignore_ascii_case("APK_API_TOKEN")
                    || !name
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                    || value.len() > 8192
                    || value.contains('\0')
            })
        {
            return Err("SDK专用环境配置无效".into());
        }
        if config
            .thread_options
            .iter()
            .any(|(name, value)| !valid_thread_option(name, value))
            || (config.thread_options.contains_key("webSearchMode")
                && config.thread_options.contains_key("webSearchEnabled"))
        {
            return Err("SDK线程选项不符合固定档案".into());
        }
        Ok(config)
    }

    pub async fn load(path: &Path) -> Result<Self, String> {
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|_| "未配置SDK部署环境")?;
        let metadata = file.metadata().await.map_err(|_| "无法检查SDK部署配置")?;
        if !metadata.is_file() || metadata.len() > CONFIG_LIMIT {
            return Err("SDK部署配置文件资格无效".into());
        }
        let mut bytes = Vec::new();
        file.take(CONFIG_LIMIT + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "SDK部署配置读取失败")?;
        Self::parse(&bytes)
    }

    pub fn project(&self, project: &str) -> Result<&Path, String> {
        self.projects
            .get(project)
            .map(PathBuf::as_path)
            .ok_or_else(|| "SDK项目未由部署者登记".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn example() -> Value {
        let root = std::env::temp_dir().join("deviceforge-sdk-config-test");
        json!({
            "format_version":1, "profile":PROFILE, "node_executable":root.join("node"),
            "node_version":NODE_VERSION, "sdk_entry":root.join("sdk/index.js"), "sdk_version":SDK_VERSION,
            "cli_executable":root.join("cli"), "cli_version":SDK_VERSION,
            "projects":{"demo":root.join("project")}, "state_root":root.join("state"),
            "codex_home":root.join("provider"), "environment":{}, "thread_options":{}
        })
    }

    #[test]
    fn versions_paths_unknown_fields_and_history_overlap_are_rejected() {
        assert!(Config::parse(&serde_json::to_vec(&example()).unwrap()).is_ok());
        for (field, replacement) in [
            ("sdk_version", json!("0.57.0")),
            ("sdk_entry", json!("relative.js")),
            ("unregistered", json!(true)),
        ] {
            let mut input = example();
            input[field] = replacement;
            assert!(Config::parse(&serde_json::to_vec(&input).unwrap()).is_err());
        }
        let mut input = example();
        input["codex_home"] = input["state_root"].clone();
        assert!(Config::parse(&serde_json::to_vec(&input).unwrap()).is_err());
    }

    #[test]
    fn deployment_options_and_secrets_never_expand_the_public_scope() {
        for options in [
            json!({"workingDirectory":"/other"}),
            json!({"model":null}),
            json!({"approvalPolicy":"unknown"}),
            json!({"webSearchMode":"live","webSearchEnabled":true}),
        ] {
            let mut input = example();
            input["thread_options"] = options;
            assert!(Config::parse(&serde_json::to_vec(&input).unwrap()).is_err());
        }
        let mut input = example();
        input["environment"] = json!({"APK_API_TOKEN":"placeholder"});
        assert!(Config::parse(&serde_json::to_vec(&input).unwrap()).is_err());
    }
}
