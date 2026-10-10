//! 参数规则回归只验证纯资格，不启动ADB或读取部署配置。
use super::*;

#[test]
fn serial_uses_utf8_bytes_and_keeps_the_host_wide_local_id_rules() {
    for value in ["设备:一", " 有空格的设备 ", "a/b;literal", "localhost:5555"] {
        assert!(serial(value).is_ok(), "{value}");
    }
    assert!(serial(&format!("{}ab", "汉".repeat(66))).is_ok());
    assert!(serial(&format!("{}abc", "汉".repeat(66))).is_err());
    for value in [
        "",
        " \t ",
        "-serial",
        "device\n",
        "device\u{7f}",
        "device\u{85}",
    ] {
        assert!(matches!(serial(value), Err(Error::Invalid(_))));
    }
}

#[test]
fn raw_and_model_limits_count_utf8_and_reject_unicode_controls() {
    assert!(bounded_text(&format!("{}a", "汉".repeat(33)), 100));
    assert!(!bounded_text(&format!("{}ab", "汉".repeat(33)), 100));
    assert!(bounded_text(&"m".repeat(200), 200));
    for value in [" ", "\u{85}", "x\u{9f}", "x\0"] {
        assert!(!bounded_text(value, 200));
    }
}

#[test]
fn connection_address_requires_a_host_and_unambiguous_port() {
    for value in [
        "127.0.0.1:5555",
        "device.local:1",
        "HOST-name:65535",
        "[::1]:5555",
        "[2001:db8::1]:22",
    ] {
        assert!(address(value).is_ok(), "{value}");
    }
    for value in [
        "host",
        ":5555",
        "host:0",
        "host:65536",
        "host:+22",
        "host:1 --flag",
        " host:1",
        "::1:5555",
        "[bad]:1",
        "999.1.1.1:1",
        "-host:1",
        "a..b:1",
        "主机:1",
        "host:\u{85}1",
    ] {
        assert!(matches!(address(value), Err(Error::Invalid(_))), "{value}");
    }
    assert!(address(&format!("{}:1", "a".repeat(199))).is_err());
}

#[test]
fn package_uses_dotted_identifiers_and_200_byte_bound() {
    for value in ["com.example", "Com.example_2", "a.b"] {
        assert!(package(value).is_ok());
    }
    assert!(package(&format!("{}.b", "a".repeat(198))).is_ok());
    assert!(package(&format!("{}.b", "a".repeat(199))).is_err());
    for value in [
        "example",
        "com..example",
        "com.2example",
        "com.-example",
        "com.example;id",
        "com.例子",
        "com.example ",
    ] {
        assert!(matches!(package(value), Err(Error::Invalid(_))));
    }
}

#[test]
fn adb_diagnostics_do_not_match_failure_words_inside_package_names() {
    for line in [
        "error: device offline",
        "adb: error: connection closed",
        "no devices/emulators found",
        "adb: device offline",
        "adb: device 'serial' not found",
    ] {
        assert!(adb_diagnostic_line(line));
    }
    for line in [
        "package:com.failed.example",
        "package:com.error.example",
        "package:com.device_offline",
        "no devices package",
        "error:serial\tdevice",
        "error:serial device",
        "adb: error:serial",
    ] {
        assert!(!adb_diagnostic_line(line));
    }
}
