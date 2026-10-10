//! 仅精确诊断行被当作ADB故障，合法包名里的failed/error不构成故障。
pub(crate) fn adb_diagnostic_line(line: &str) -> bool {
    let line = line.trim().to_ascii_lowercase();
    diagnostic_prefix(&line, "error:")
        || diagnostic_prefix(&line, "adb: error:")
        || line == "no devices/emulators found"
        || line == "no devices found"
        || line == "device offline"
        || line == "device unauthorized"
        || line == "adb: no devices/emulators found"
        || line == "adb: device offline"
        || line == "adb: device unauthorized"
        || (line.starts_with("adb: device ") && line.ends_with(" not found"))
}

fn diagnostic_prefix(line: &str, prefix: &str) -> bool {
    line.strip_prefix(prefix)
        .is_some_and(|tail| tail.is_empty() || tail.starts_with(char::is_whitespace))
}
