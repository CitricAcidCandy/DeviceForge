//! 仅检查本次夹具的直接 PID，不发送终止信号，不推断进程树或外部资源状态。

#[cfg(windows)]
pub fn alive(pid: u32) -> bool {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    // 只请求等待权限；权限错误不得当作进程已经退出。
    let handle = unsafe { OpenProcess(0x0010_0000, 0, pid) };
    if handle.is_null() {
        assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(87));
        return false;
    }
    let status = unsafe { WaitForSingleObject(handle, 0) };
    assert_ne!(unsafe { CloseHandle(handle) }, 0);
    match status {
        0 => false,
        258 => true,
        _ => panic!("无法确认本次 PID 状态：{status}"),
    }
}

#[cfg(unix)]
pub fn alive(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    // 信号零仅检查存在性；无权限也视为仍存在。
    if unsafe { kill(i32::try_from(pid).expect("合法 PID"), 0) } == 0 {
        return true;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(3) => false,
        Some(1) => true,
        error => panic!("本次 PID 探测失败：{error:?}"),
    }
}
