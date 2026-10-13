//! ADB发现整份映射；坏条目或重复标识使整次失败，不返回部分目录。
use crate::{Error, Result, rules};
use apk_plugin_sdk::devices::{CapabilityAvailability, DeviceState, PluginDevice};
use std::collections::HashSet;

const DEVICE_CAPABILITIES: [&str; 11] = [
    "packages",
    "app.start",
    "app.stop",
    "app.uninstall",
    "input",
    "app.install",
    "app.install_apks",
    "screenshot",
    "performance.sample",
    "stack.probe",
    "profile.record",
];

pub(crate) fn parse(output: &str) -> Result<Vec<PluginDevice>> {
    let mut devices = Vec::new();
    let mut ids = HashSet::new();
    for line in output.lines() {
        // 制表符只作为ADB列分隔符；其它Unicode控制符不能被trim悄悄消除。
        if line
            .chars()
            .any(|character| character.is_control() && character != '\t')
        {
            return Err(Error::Dependency("设备发现输出含非法控制符"));
        }
        let line = line.trim();
        if ignored_line(line) {
            continue;
        }
        // 明确的serial制表符列先按设备资格解析，保留error:等合法标识原文。
        // 仅尾部含制表符的诊断仍拒绝；不能把任意含Tab的文本都当成设备行。
        let tab_columns = line
            .find(char::is_whitespace)
            .is_some_and(|offset| line.as_bytes()[offset] == b'\t');
        if !tab_columns && rules::adb_diagnostic_line(line) {
            return Err(Error::Dependency("ADB未返回有效设备目录"));
        }
        let mut parts = line.split_whitespace();
        let id = parts
            .next()
            .ok_or(Error::Dependency("设备发现条目缺少标识"))?;
        let raw_state = parts
            .next()
            .ok_or(Error::Dependency("设备发现条目缺少原始状态"))?;
        if rules::serial(id).is_err() || !rules::bounded_text(raw_state, 100) {
            return Err(Error::Dependency("设备发现标识或原始状态不符合资格"));
        }
        let mut model = None;
        for part in parts {
            if let Some(value) = part.strip_prefix("model:") {
                if model.is_some() || !rules::bounded_text(value, 200) {
                    return Err(Error::Dependency("设备发现型号不符合资格"));
                }
                model = Some(value.to_owned());
            }
        }
        if devices.len() >= 128 || !ids.insert(id.to_owned()) {
            return Err(Error::Dependency("设备发现超过128条或包含重复标识"));
        }
        let state = match raw_state {
            "device" => DeviceState::Online,
            "offline" => DeviceState::Offline,
            "unauthorized" => DeviceState::Unauthorized,
            _ => DeviceState::Unknown,
        };
        let reason = match state {
            DeviceState::Online => None,
            DeviceState::Offline => Some("设备离线"),
            DeviceState::Unauthorized => Some("设备尚未授权"),
            DeviceState::Unknown => Some("设备原始状态暂不允许动作"),
        };
        let capabilities = DEVICE_CAPABILITIES
            .iter()
            .map(|id| CapabilityAvailability {
                id: (*id).to_owned(),
                version: 1,
                available: reason.is_none(),
                reason: reason.map(str::to_owned),
            })
            .collect();
        devices.push(PluginDevice {
            id: id.to_owned(),
            state,
            raw_state: Some(raw_state.to_owned()),
            model,
            capabilities,
        });
    }
    Ok(devices)
}

fn ignored_line(line: &str) -> bool {
    matches!(
        line,
        "" | "List of devices attached"
            | "* daemon not running; starting now at tcp:5037"
            | "* daemon started successfully"
            | "* daemon not running. starting it now on port 5037 *"
            | "* daemon started successfully *"
    )
}

#[cfg(test)]
#[path = "discovery/tests.rs"]
mod tests;
