//! 宿主管理的不可变工具绑定，与任务协议及用户配置分别演进。
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{self, Read},
    path::{Path, PathBuf},
};

const LIMIT: u64 = 256 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedResources {
    pub format_version: u32,
    pub release_id: String,
    pub revision: String,
    pub tools: BTreeMap<String, ManagedTool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<ManagedRepository>,
    /// 新快照仅对这些工具取得仓库租约；值为仓库包修订，未列出的入口为外部引用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_tools: Option<BTreeMap<String, String>>,
    /// 脚本解释器随本次不可变资源快照选择，与配置绑定独立。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<crate::packages::RuntimeDependency>,
    #[serde(default)]
    pub bindings: Vec<ResourceBinding>,
}

/// 宿主公开的本机工具仓库描述，只含受控根与调用方命名空间，不含网络凭据。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedRepository {
    pub format_version: u32,
    pub root: PathBuf,
    pub client_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedTool {
    pub version: String,
    pub platform: String,
    pub entries: BTreeMap<String, PathBuf>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceBinding {
    pub tool_id: String,
    pub component_id: String,
    pub config_pointer: String,
    pub entry: String,
}

impl ManagedResources {
    pub fn read(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(invalid("资源绑定文件必须为绝对路径"));
        }
        let file = std::fs::File::open(path)?;
        let mut bytes = Vec::new();
        file.take(LIMIT + 1).read_to_end(&mut bytes)?;
        Self::decode(&bytes)
    }

    fn decode(bytes: &[u8]) -> io::Result<Self> {
        if bytes.len() as u64 > LIMIT {
            return Err(invalid("资源绑定超过 256 KiB"));
        }
        let value: Self =
            serde_json::from_slice(bytes).map_err(|_| invalid("资源绑定 JSON 无效"))?;
        if value.format_version != 1
            || value.release_id.is_empty()
            || value.revision.len() != 64
            || !value.revision.bytes().all(|b| b.is_ascii_hexdigit())
            || value.tools.values().any(|tool| {
                tool.version.is_empty()
                    || tool.platform.is_empty()
                    || tool.entries.values().any(|path| !path.is_absolute())
            })
        {
            return Err(invalid("资源绑定版本或路径无效"));
        }
        if value.repository.as_ref().is_some_and(|repository| {
            repository.format_version != 1
                || !repository.root.is_absolute()
                || repository.client_id.is_empty()
                || repository.client_id.len() > 128
                || !repository
                    .client_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        }) {
            return Err(invalid("托管仓库描述无效"));
        }
        if value.managed_tools.as_ref().is_some_and(|tools| {
            tools.iter().any(|(id, version)| {
                !value.tools.contains_key(id) || version.is_empty() || version.len() > 200
            })
        }) {
            return Err(invalid("托管工具身份映射无效"));
        }
        Ok(value)
    }

    /// 按发布声明的稳定键取入口，不依赖系统 PATH 或安装目录布局。
    pub fn entry(&self, tool_id: &str, entry: &str) -> io::Result<&Path> {
        self.tools
            .get(tool_id)
            .and_then(|tool| tool.entries.get(entry))
            .map(PathBuf::as_path)
            .ok_or_else(|| invalid("发布未绑定所需工具入口"))
    }
}

/// 旧部署没有此环境变量时返回 None；存在但损坏的绑定不能静默回退。
pub fn managed_resources() -> io::Result<Option<ManagedResources>> {
    std::env::var_os("DEVICEFORGE_PLUGIN_RESOURCES")
        .map(|path| ManagedResources::read(Path::new(&path)))
        .transpose()
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binding_rejects_bad_version_relative_paths_and_oversize() {
        let executable = std::env::current_exe().unwrap();
        let mut value = serde_json::json!({"format_version":1,"release_id":"third-party",
            "revision":"a".repeat(64),"tools":{"runtime":{"version":"1","platform":"windows-x86_64","entries":{"main":executable}}}});
        let resources = ManagedResources::decode(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(resources.entry("runtime", "main").unwrap().is_absolute());
        assert!(resources.entry("missing", "main").is_err());
        value["tools"]["runtime"]["entries"]["main"] = "relative.exe".into();
        assert!(ManagedResources::decode(&serde_json::to_vec(&value).unwrap()).is_err());
        value["format_version"] = 9.into();
        assert!(ManagedResources::decode(&serde_json::to_vec(&value).unwrap()).is_err());
        assert!(ManagedResources::decode(&vec![b' '; LIMIT as usize + 1]).is_err());
    }

    #[test]
    fn optional_repository_descriptor_keeps_legacy_and_rejects_invalid_clients() {
        let mut value = serde_json::json!({"format_version":1,"release_id":"supplier","revision":"a".repeat(64),"tools":{}});
        assert!(
            ManagedResources::decode(&serde_json::to_vec(&value).unwrap())
                .unwrap()
                .repository
                .is_none()
        );
        value["repository"] = serde_json::json!({"format_version":1,"root":std::env::current_dir().unwrap(),"client_id":"tool-supply"});
        let resources = ManagedResources::decode(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(resources.repository.unwrap().client_id, "tool-supply");
        for client in ["../escape", "", "invalid:client"] {
            value["repository"]["client_id"] = client.into();
            assert!(ManagedResources::decode(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }
}
