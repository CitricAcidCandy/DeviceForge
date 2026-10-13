use std::{ffi::c_void, io, ptr::NonNull};

#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn GetProcessTimes(
        handle: *mut c_void,
        creation: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
    fn QueryFullProcessImageNameW(
        handle: *mut c_void,
        flags: u32,
        path: *mut u16,
        length: *mut u32,
    ) -> i32;
}

pub struct ProcessObservation {
    handle: NonNull<c_void>,
    pub pid: u32,
    pub creation: String,
    pub role: String,
}

unsafe impl Send for ProcessObservation {}
unsafe impl Sync for ProcessObservation {}

impl ProcessObservation {
    pub fn new(pid: u32, creation: &str, role: &str, expected_executable: &str) -> Self {
        let raw = unsafe { OpenProcess(0x0010_1000, 0, pid) };
        let handle = NonNull::new(raw)
            .unwrap_or_else(|| panic!("取得真实进程句柄失败：{}", io::Error::last_os_error()));
        let value = Self {
            handle,
            pid,
            creation: creation.to_owned(),
            role: role.to_owned(),
        };
        let mut created = FileTime::default();
        let mut exited = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        assert_ne!(
            unsafe { GetProcessTimes(raw, &mut created, &mut exited, &mut kernel, &mut user) },
            0
        );
        assert_eq!(
            ((u64::from(created.high) << 32) | u64::from(created.low)).to_string(),
            creation
        );
        let mut path = [0_u16; 4096];
        let mut length = path.len() as u32;
        assert_ne!(
            unsafe { QueryFullProcessImageNameW(raw, 0, path.as_mut_ptr(), &mut length) },
            0
        );
        let actual = String::from_utf16(&path[..length as usize]).expect("实际程序路径UTF-16");
        let normalize = |path: &str| path.trim_start_matches("\\\\?\\").to_lowercase();
        assert_eq!(normalize(&actual), normalize(expected_executable));
        assert!(value.running(), "取得句柄时必须真实存活");
        value
    }

    pub fn running(&self) -> bool {
        let status = unsafe { WaitForSingleObject(self.handle.as_ptr(), 0) };
        assert!(status == 0 || status == 258, "实际等待状态无效");
        status == 258
    }

    pub fn exited(&self) -> bool {
        (unsafe { WaitForSingleObject(self.handle.as_ptr(), 0) }) == 0
    }

    pub fn exit_record(&self) -> serde_json::Value {
        assert!(self.exited(), "真实OS退出必须已确认");
        let mut code = 0;
        assert_ne!(
            unsafe { GetExitCodeProcess(self.handle.as_ptr(), &mut code) },
            0
        );
        serde_json::json!({"role":self.role,"pid":self.pid,"creation_time_100ns":self.creation,
            "wait_status":0,"exit_code":code,"handle_acquired":true,"test_kill":false})
    }
}

impl Drop for ProcessObservation {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle.as_ptr());
        }
    }
}
