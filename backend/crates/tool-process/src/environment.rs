//! 宿主启动插件与插件启动工具共享受限环境，避免上游丢失必要运行上下文。

use std::{collections::BTreeMap, ffi::OsString};

const RESTRICTED_KEYS: [&str; 14] = [
    "PATH",
    "SystemRoot",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "COMSPEC",
    "PATHEXT",
    "PSModulePath",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
];

/// 仅快照程序查找、系统、目录和终端运行所需白名单；不继承宿主令牌。
/// 调用方须先清空子进程环境，再应用本快照及本次显式部署参数。
pub fn restricted_environment() -> BTreeMap<OsString, OsString> {
    collect(|key| std::env::var_os(key))
}

fn collect(mut read: impl FnMut(&str) -> Option<OsString>) -> BTreeMap<OsString, OsString> {
    RESTRICTED_KEYS
        .into_iter()
        .filter_map(|key| read(key).map(|value| (OsString::from(key), value)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricted_snapshot_preserves_runtime_values_and_excludes_credentials() {
        let mut source: BTreeMap<OsString, OsString> = [
            ("PATHEXT", ".COM;.EXE;.BAT;.CMD;.CPL"),
            ("COMSPEC", r"C:\Windows\System32\cmd.exe"),
            ("APPDATA", r"C:\Users\测试\AppData\Roaming"),
            ("LOCALAPPDATA", r"C:\Users\测试\AppData\Local"),
            ("PSModulePath", r"C:\Program Files\PowerShell\Modules"),
            ("ProgramFiles", r"C:\Program Files"),
            ("ProgramFiles(x86)", r"C:\Program Files (x86)"),
            ("ProgramW6432", r"C:\Program Files"),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect();
        let expected = source.clone();
        for key in [
            "APK_API_TOKEN",
            "OPENAI_API_KEY",
            "TIMICC_API_KEY",
            "DEVICEFORGE_PLUGIN_CONFIG",
            "DEVICEFORGE_PLUGIN_RESOURCES",
            "NODE_OPTIONS",
        ] {
            source.insert(key.into(), "仅用于排除测试的固定值".into());
        }
        let actual = collect(|key| source.get(std::ffi::OsStr::new(key)).cloned());
        assert_eq!(actual, expected);
    }

    #[test]
    fn missing_keys_are_not_synthesized_and_repeated_filtering_keeps_context() {
        let expected: BTreeMap<OsString, OsString> = [
            ("PATH", r"C:\工具\node"),
            ("PATHEXT", ".EXE;.CMD"),
            ("USERPROFILE", r"C:\Users\测试"),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect();
        let once = collect(|key| expected.get(std::ffi::OsStr::new(key)).cloned());
        let twice = collect(|key| once.get(std::ffi::OsStr::new(key)).cloned());
        assert_eq!(once, expected);
        assert_eq!(twice, expected);
        assert!(collect(|_| None).is_empty());
    }
}
