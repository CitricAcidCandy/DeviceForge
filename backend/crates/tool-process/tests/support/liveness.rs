//! 只探测本次夹具 PID 的存在性；不发送终止信号，不推断派生进程树状态。

#[cfg(windows)]
pub fn alive(pid: u32) -> bool {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    // 只请求等待权限；句柄始终在返回前关闭。
    let handle = unsafe { OpenProcess(0x0010_0000, 0, pid) };
    if handle.is_null() {
        let error = std::io::Error::last_os_error();
        assert_eq!(
            error.raw_os_error(),
            Some(87),
            "PID 探测权限或系统错误不能当作退出"
        );
        return false;
    }
    let status = unsafe { WaitForSingleObject(handle, 0) };
    assert_ne!(unsafe { CloseHandle(handle) }, 0, "关闭 PID 探测句柄");
    match status {
        0 => false,
        258 => true,
        _ => panic!("PID 等待状态无法确认：{status}"),
    }
}

#[cfg(unix)]
pub fn alive(pid: u32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    // 信号零只检查存在性；没有权限也应视为仍存在。
    if unsafe { kill(i32::try_from(pid).expect("合法 PID"), 0) } == 0 {
        return true;
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(3) => false,
        Some(1) => true,
        error => panic!("PID 探测失败：{error:?}"),
    }
}
