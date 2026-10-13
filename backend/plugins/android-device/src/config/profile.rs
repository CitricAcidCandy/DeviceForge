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
    #[serde(default)]
    pub scrcpy_server: Option<std::path::PathBuf>,
    #[serde(default)]
    pub server_version: Option<String>,
    #[serde(default)]
    pub ffmpeg: Option<String>,
    #[serde(default)]
    pub ffprobe: Option<String>,
    #[serde(default)]
    pub clock_helper: Option<std::path::PathBuf>,
}
fn simpleperf_default() -> String { "/system/bin/simpleperf".into() }
fn su_default() -> String { "su".into() }
impl Default for Profile {
    fn default() -> Self { Self { root_access: RootAccess::default(), simpleperf: simpleperf_default(), su: su_default(), scrcpy_server:None, server_version:None, ffmpeg:None, ffprobe:None, clock_helper:None } }
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
        for path in [&self.scrcpy_server, &self.clock_helper].into_iter().flatten() {
            super::absolute(path)?;
        }
        if let Some(ffmpeg) = &self.ffmpeg { super::program_named(ffmpeg, "FFmpeg入口须为绝对路径或单一程序名")?; }
        if let Some(ffprobe) = &self.ffprobe { super::program_named(ffprobe, "FFprobe入口须为绝对路径或单一程序名")?; }
        if self.server_version.as_ref().is_some_and(|x| x.is_empty() || x.len()>32 || !x.bytes().all(|b| b.is_ascii_digit() || b == b'.')) {
            return Err(Error::Invalid("scrcpy服务版本字段无效"));
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
