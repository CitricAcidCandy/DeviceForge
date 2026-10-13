//! 设备端Root方式及Simpleperf入口只由部署者选择。
use crate::{Error, Result};
use serde::Deserialize;
#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RootAccess {
    #[default]
    Auto,
    AdbdRoot,
    SuC,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Profile {
    #[serde(default)]
    pub root_access: RootAccess,
    #[serde(default = "simpleperf_default")]
    pub simpleperf: String,
    #[serde(default = "su_default")]
    pub su: String,
}
fn simpleperf_default() -> String { "/system/bin/simpleperf".into() }
fn su_default() -> String { "su".into() }
impl Default for Profile {
    fn default() -> Self { Self { root_access: RootAccess::default(), simpleperf: simpleperf_default(), su: su_default() } }
}
fn device_path(value: &str) -> bool {
    value.starts_with('/') && value.len() <= 1024
        && !value.split('/').skip(1).any(|x| x.is_empty() || matches!(x,"."|".."))
        && value.bytes().all(|x| x.is_ascii_alphanumeric() || matches!(x,b'/'|b'_'|b'-'|b'.'))
}
impl Profile {
    pub(crate) fn validate(&self) -> Result<()> {
        if !device_path(&self.simpleperf) || (self.su != "su" && !device_path(&self.su)) {
            return Err(Error::Invalid("Root工具入口须为受检设备路径或固定su程序名"));
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deploy_path_cannot_be_shell_text_or_parent_path() {
        for path in ["simpleperf", "/data/../simpleperf", "/data//simpleperf", "/data/simpleperf;id", "/data/simple perf"] {
            assert!(Profile { simpleperf:path.into(), ..Profile::default() }.validate().is_err());
        }
        assert!(Profile::default().validate().is_ok());
        assert!(serde_json::from_str::<Profile>(r#"{"root_access":"su_c","su":"/system/xbin/su"}"#).unwrap().validate().is_ok());
    }
}
