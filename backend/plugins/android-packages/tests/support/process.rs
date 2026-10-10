//! 仅观测本次 ready 标记对应的真实工具 PID，不宣称派生树或 daemon 清理。
use std::{
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
mod native {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    pub struct Probe(*mut c_void);
    impl Probe {
        pub fn open(pid: u32) -> Self {
            let handle = unsafe { OpenProcess(0x0010_0000, 0, pid) };
            assert!(!handle.is_null(), "ready 后立即持有本次 PID 的等待句柄");
            Self(handle)
        }
        pub fn exited(&self) -> bool {
            let result = unsafe { WaitForSingleObject(self.0, 0) };
            assert!(result == 0 || result == 258, "本次进程等待查询必须成功");
            result == 0
        }
    }
    impl Drop for Probe {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(unix)]
mod native {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    pub struct Probe(i32);
    impl Probe {
        pub fn open(pid: u32) -> Self {
            let probe = Self(i32::try_from(pid).unwrap());
            assert!(!probe.exited(), "ready 后本次工具仍在运行");
            probe
        }
        pub fn exited(&self) -> bool {
            let result = unsafe { kill(self.0, 0) };
            if result == 0 {
                return false;
            }
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(3),
                "只接受 ESRCH 为 PID 不存在"
            );
            true
        }
    }
}

pub struct PidProbe {
    pid: u32,
    inner: native::Probe,
}
impl PidProbe {
    pub fn open(pid: u32) -> Self {
        Self {
            pid,
            inner: native::Probe::open(pid),
        }
    }
    pub fn assert_running(&self) {
        assert!(!self.inner.exited(), "本次 PID {} 应仍在门闩内", self.pid);
    }
    pub fn assert_exited(&self) {
        let limit = Instant::now() + Duration::from_secs(3);
        while !self.inner.exited() {
            assert!(Instant::now() < limit, "本次真实 PID {} 没有退出", self.pid);
            thread::sleep(Duration::from_millis(5));
        }
    }
}
