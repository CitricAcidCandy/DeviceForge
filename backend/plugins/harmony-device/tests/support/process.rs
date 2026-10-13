//! 仅判断ready后持有的本次客户端进程；不从marker推断进程退出。
use std::{
    fs,
    path::PathBuf,
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
        fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
        fn TerminateProcess(handle: *mut c_void, code: u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    pub struct Probe(*mut c_void);
    impl Probe {
        pub fn open(pid: u32) -> Self {
            let handle = unsafe { OpenProcess(0x0010_1001, 0, pid) };
            assert!(!handle.is_null(), "ready后取得本次PID等待句柄");
            Self(handle)
        }
        pub fn exited(&self) -> bool {
            let result = unsafe { WaitForSingleObject(self.0, 0) };
            assert!(result == 0 || result == 258);
            result == 0
        }
        pub fn exit_code(&self) -> u32 {
            assert!(self.exited());
            let mut code = 0;
            assert_ne!(unsafe { GetExitCodeProcess(self.0, &mut code) }, 0);
            code
        }
    }
    impl Drop for Probe {
        fn drop(&mut self) {
            if std::thread::panicking() && !self.exited() {
                // 失败兜底仅处理此句柄，不计清理成功，不声称清理进程树。
                unsafe {
                    TerminateProcess(self.0, 99);
                }
            }
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
            let value = Self(i32::try_from(pid).unwrap());
            assert!(!value.exited());
            value
        }
        pub fn exited(&self) -> bool {
            if unsafe { kill(self.0, 0) } == 0 {
                return false;
            }
            assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(3));
            true
        }
    }
    impl Drop for Probe {
        fn drop(&mut self) {
            if std::thread::panicking() && !self.exited() {
                unsafe {
                    kill(self.0, 9);
                }
            }
        }
    }
}

pub struct PidProbe {
    pid: u32,
    native: native::Probe,
    fallback: PathBuf,
}
impl PidProbe {
    pub fn open(pid: u32, fallback: PathBuf) -> Self {
        Self {
            pid,
            native: native::Probe::open(pid),
            fallback,
        }
    }
    pub fn assert_running(&self) {
        assert!(!self.native.exited(), "本次PID {}应在门闩内", self.pid);
    }
    pub fn assert_exited(&self) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !self.native.exited() {
            assert!(Instant::now() < deadline, "本次PID {}未退出", self.pid);
            thread::sleep(Duration::from_millis(5));
        }
    }
    #[cfg(windows)]
    pub fn assert_exit_code(&self, expected: u32) {
        self.assert_exited();
        let actual = self.native.exit_code();
        fs::write(
            self.fallback.with_extension("os-exit.json"),
            format!(
                r#"{{"pid":{},"code":{actual},"test_kill":false}}"#,
                self.pid
            ),
        )
        .unwrap();
        assert_eq!(actual, expected);
    }
}
impl Drop for PidProbe {
    fn drop(&mut self) {
        if std::thread::panicking() && !self.native.exited() {
            let _ = fs::write(&self.fallback, b"failed-test-direct-pid-only");
        }
    }
}
