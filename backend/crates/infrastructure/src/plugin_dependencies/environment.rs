//! 只读取声明所需变量与 PATH；Windows 注册表变更无需重启宿主即可生效。
use std::{ffi::OsString, path::PathBuf};

pub(super) fn value(name: &str) -> Option<OsString> {
    registry(name, true)
        .or_else(|| registry(name, false))
        .or_else(|| std::env::var_os(name))
}

pub(super) fn path_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    for value in [
        registry("PATH", false),
        registry("PATH", true),
        std::env::var_os("PATH"),
    ]
    .into_iter()
    .flatten()
    {
        for path in std::env::split_paths(&value) {
            if path.is_absolute() && !directories.contains(&path) {
                directories.push(path);
            }
            if directories.len() >= 256 {
                return directories;
            }
        }
    }
    directories
}

#[cfg(not(windows))]
fn registry(_: &str, _: bool) -> Option<OsString> {
    None
}

#[cfg(windows)]
fn registry(name: &str, user: bool) -> Option<OsString> {
    use std::{
        ffi::c_void,
        os::windows::ffi::{OsStrExt, OsStringExt},
    };
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegGetValueW(
            key: *mut c_void,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut c_void,
            size: *mut u32,
        ) -> i32;
    }
    let key = if user { 0x80000001u32 } else { 0x80000002u32 } as i32 as isize as *mut c_void;
    let subkey = if user {
        "Environment"
    } else {
        "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"
    };
    let wide = |value: &str| {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let subkey = wide(subkey);
    let name = wide(name);
    let mut data = vec![0u16; 32768];
    let mut size = (data.len() * 2) as u32;
    // 固定根、固定字符串类型及固定缓冲区，禁止遍历或继承注册表中的其他变量。
    let status = unsafe {
        RegGetValueW(
            key,
            subkey.as_ptr(),
            name.as_ptr(),
            0x10000006,
            std::ptr::null_mut(),
            data.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 || size == 0 || size as usize > data.len() * 2 {
        return None;
    }
    data.truncate(size as usize / 2);
    while data.last() == Some(&0) {
        data.pop();
    }
    let mut value = OsString::from_wide(&data).to_string_lossy().into_owned();
    for variable in [
        "SystemRoot",
        "USERPROFILE",
        "LOCALAPPDATA",
        "ProgramFiles",
        "ProgramFiles(x86)",
    ] {
        if let Some(expansion) = std::env::var_os(variable) {
            value = value.replace(&format!("%{variable}%"), &expansion.to_string_lossy());
        }
    }
    Some(value.into())
}
