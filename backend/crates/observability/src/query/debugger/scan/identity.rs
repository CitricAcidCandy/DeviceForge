//! 文件身份直接取已打开句柄，避免同名轮转替换后继续使用旧偏移。
use std::{fs::File, io};

#[cfg(unix)]
pub(super) fn file_id(file: &File) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
pub(super) fn file_id(file: &File) -> io::Result<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Information {
        attributes: u32,
        created: FileTime,
        accessed: FileTime,
        written: FileTime,
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(
            handle: *mut std::ffi::c_void,
            information: *mut Information,
        ) -> i32;
    }
    let mut information = Information::default();
    // 文件在调用期间保持打开，结构与 Win32 的 BY_HANDLE_FILE_INFORMATION 布局一致。
    let success = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((
        u64::from(information.volume),
        (u64::from(information.index_high) << 32) | u64::from(information.index_low),
    ))
}

#[cfg(not(any(unix, windows)))]
pub(super) fn file_id(_file: &File) -> io::Result<(u64, u64)> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "当前系统未提供日志文件身份实现",
    ))
}
