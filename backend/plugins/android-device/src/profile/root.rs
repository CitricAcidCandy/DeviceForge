//! 只探测现有adbd UID0或部署允许的固定su -c；不改变设备安全设置。
use crate::{Error, Result, config::profile::{Profile, RootAccess}, session::Session};
use deviceforge_plugin_runtime::Output;
use serde_json::json;
use std::time::Duration;
#[derive(Debug, Clone)]
pub(crate) enum Access { AdbdRoot, Su(String) }
impl Access {
    pub(crate) fn name(&self) -> &'static str {
        match self { Self::AdbdRoot => "adbd_root", Self::Su(_) => "su" }
    }
}
pub(crate) struct Qualification {
    pub access: Option<Access>,
    pub available: bool,
    pub supported: bool,
    pub reason: Option<&'static str>,
}
pub(crate) fn quote(value: &str) -> String {
    format!("'{}'",value.replace('\'',"'\\''"))
}
pub(crate) fn command(device: &str, access: Option<&Access>, script: &str) -> Vec<String> {
    let mut args = vec!["-s".into(),device.into(),"shell".into(),"-T".into()];
    match access {
        Some(Access::Su(path)) => args.extend([path.clone(),"-c".into(),quote(script)]),
        _ => args.extend(["/system/bin/sh".into(),"-c".into(),quote(script)]),
    }
    args
}
pub(crate) fn argv(device: &str, access: Option<&Access>, tail: &[&str]) -> Vec<String> {
    let script = tail.iter().map(|x| quote(x)).collect::<Vec<_>>().join(" ");
    command(device,access,&script)
}
impl Session {
    async fn root_try(&self, device: &str, access: Option<&Access>, tail: &[&str]) -> Result<Option<String>> {
        let args = argv(device,access,tail);
        let result = self.control.capture(&args,Some(Duration::from_millis(750))).await;
        self.control.check()?;
        match result {
            Ok(output) => {
                if output.stdout.len() + output.stderr.len() > 64*1024 { return Ok(None); }
                let mut bytes = output.stdout;
                if !output.stderr.is_empty() { bytes.push(b'\n'); bytes.extend(output.stderr); }
                Ok(String::from_utf8(bytes).ok())
            }
            Err(Error::CleanupFailed) => Err(Error::CleanupFailed),
            Err(_) => Ok(None),
        }
    }
    pub(crate) async fn root_qualification(&self, device: &str, config: &Profile) -> Result<Qualification> {
        let plain = self.root_try(device,None,&["id","-u"]).await?;
        let mut access = if !matches!(config.root_access,RootAccess::SuC) && plain.as_deref().map(str::trim) == Some("0") { Some(Access::AdbdRoot) } else { None };
        if access.is_none() && !matches!(config.root_access,RootAccess::AdbdRoot) {
            let candidate = Access::Su(config.su.clone());
            if self.root_try(device,Some(&candidate),&["id","-u"]).await?.as_deref().map(str::trim) == Some("0") {
                access = Some(candidate);
            }
        }
        let Some(root) = access.as_ref() else {
            return Ok(Qualification { access:None,available:false,supported:false,reason:Some("设备未取得Root权限，已保留指标与采样画面能力") });
        };
        let version = self.root_try(device,Some(root),&[&config.simpleperf,"--version"]).await?;
        let available = version.as_ref().is_some_and(|x| !x.trim().is_empty());
        let record = if available { self.root_try(device,Some(root),&[&config.simpleperf,"record","--help"]).await? } else { None };
        let report = if available { self.root_try(device,Some(root),&[&config.simpleperf,"report-sample","--help"]).await? } else { None };
        let supported = record.as_ref().is_some_and(|x| x.contains("--clockid") && x.contains("--keep-failed-unwinding-result"))
            && report.as_ref().is_some_and(|x| x.contains("--protobuf") && x.contains("--show-callchain"));
        Ok(Qualification { access,available,supported,reason:if supported { None } else { Some("设备Simpleperf入口或所需报告参数不可用，已保留指标与采样画面能力") } })
    }
    pub(crate) async fn stack_probe(&self, device_id: String, package: String, config: &Profile) -> Result<Output> {
        let qualification = self.root_qualification(&device_id,config).await?;
        Ok(Output::from(json!({
            "format_version":1,"device_id":device_id,"package":package,
            "root_access":qualification.access.as_ref().map(Access::name).unwrap_or("none"),
            "simpleperf_available":qualification.available,"clock":"boottime",
            "supported":qualification.supported,"reason":qualification.reason
        })))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_su_c_preserves_script_as_one_shell_argument() {
        let args = argv("serial",Some(&Access::Su("su".into())),&["cat","/proc/100/stat"]);
        assert_eq!(&args[..6],["-s","serial","shell","-T","su","-c"]);
        assert!(args[6].contains("/proc/100/stat"));
        assert_eq!(quote("a'b"),"'a'\\''b'");
    }
}
