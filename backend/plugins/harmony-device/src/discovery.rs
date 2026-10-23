use crate::{Error, Result, rules};
use apk_plugin_sdk::devices::{CapabilityAvailability, DeviceState, PluginDevice};
use std::collections::HashSet;

pub(crate) fn parse(output: &str) -> Result<Vec<PluginDevice>> {
    let mut devices = Vec::new();
    let mut ids = HashSet::new();
    for raw_line in output.split_inclusive('\n') {
        // HDC在Windows实测返回CRCRLF；只兼容明确行尾，不清洗行内或末尾裸CR。
        let line = raw_line
            .strip_suffix("\r\r\n")
            .or_else(|| raw_line.strip_suffix("\r\n"))
            .or_else(|| raw_line.strip_suffix('\n'))
            .unwrap_or(raw_line);
        if line.chars().any(char::is_control) {
            return Err(Error::Dependency("HDC发现输出含非法控制符"));
        }
        let id = line.trim();
        if matches!(id, "" | "[Empty]") {
            continue;
        }
        if id.starts_with('[')
            || rules::serial(id).is_err()
            || devices.len() >= 128
            || !ids.insert(id.to_owned())
        {
            return Err(Error::Dependency("HDC发现条目无效、重复或超过128条"));
        }
        devices.push(PluginDevice {
            id: id.to_owned(),
            state: DeviceState::Online,
            raw_state: Some("device".into()),
            model: None,
            capabilities: [
                "packages",
                "app.install",
                "app.uninstall",
                "app.detail",
                "app.start",
                "app.stop",
                "app.reset",
                "screenshot",
            ]
            .into_iter()
            .map(|id| CapabilityAvailability {
                id: id.into(),
                version: 1,
                available: true,
                reason: None,
            })
            .collect(),
        });
    }
    Ok(devices)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_empty_marker_and_devices_map_all_eight_capabilities() {
        assert!(parse("[Empty]\r\n").unwrap().is_empty());
        let devices = parse(" HDC001 \r\nHDC002\n").unwrap();
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].id, "HDC001");
        assert_eq!(devices[0].raw_state.as_deref(), Some("device"));
        assert_eq!(devices[0].capabilities.len(), 8);
    }

    #[test]
    fn crcrlf_empty_marker_is_an_explicit_empty_directory() {
        assert!(parse("[Empty]\r\r\n").unwrap().is_empty());
    }

    #[test]
    fn crcrlf_device_lines_keep_order_and_capabilities() {
        let devices = parse(" HDC001 \r\r\n127.0.0.1:5555\r\r\n").unwrap();
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].id, "HDC001");
        assert_eq!(devices[1].id, "127.0.0.1:5555");
        assert!(devices.iter().all(|device| device.capabilities.len() == 8));
    }

    #[test]
    fn crcrlf_compatibility_does_not_accept_other_control_characters() {
        for output in [
            "HDC\r001\r\r\n",
            "HDC001\r",
            "HDC001\r\r",
            "HDC001\rHDC002\n",
            "HDC001\t\r\r\n",
            "HDC001\r\r\r\n",
            "\u{1b}[0mHDC001\r\r\n",
        ] {
            assert_eq!(
                parse(output).unwrap_err().to_string(),
                "工具依赖失败：HDC发现输出含非法控制符"
            );
        }
    }

    #[test]
    fn bad_duplicate_and_overflow_reject_entire_result() {
        for output in [
            "HDC001\ninvalid device",
            "HDC001\nHDC001",
            "[Error] Unknown device",
            "serial\t",
        ] {
            assert!(parse(output).is_err());
        }
        let output = (0..129)
            .map(|index| format!("serial{index}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(parse(&output).is_err());
    }
}
