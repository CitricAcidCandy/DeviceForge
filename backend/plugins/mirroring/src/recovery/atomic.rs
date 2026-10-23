//! 同目录原子替换；Windows 额外等待写入穿透，Unix 刷新父目录。
use std::path::Path;

pub(crate) fn replace(pending: &Path, target: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32;
        }
        let source: Vec<_> = pending.as_os_str().encode_wide().chain([0]).collect();
        let target: Vec<_> = target.as_os_str().encode_wide().chain([0]).collect();
        if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 1 | 8) } == 0 {
            return Err("资源状态原子发布失败".into());
        }
    }
    #[cfg(not(windows))]
    std::fs::rename(pending, target).map_err(|_| "资源状态原子发布失败")?;
    #[cfg(unix)]
    std::fs::File::open(target.parent().ok_or("资源状态父目录缺失")?)
        .and_then(|file| file.sync_all())
        .map_err(|_| "资源状态目录刷新失败")?;
    Ok(())
}
