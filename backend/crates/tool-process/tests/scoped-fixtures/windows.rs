use std::{ffi::c_void, io};

type RawHandle = *mut c_void;

#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> RawHandle;
    fn GetProcessTimes(
        process: RawHandle,
        creation: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> RawHandle;
    fn CloseHandle(handle: RawHandle) -> i32;
    fn QueryFullProcessImageNameW(
        process: RawHandle,
        flags: u32,
        name: *mut u16,
        size: *mut u32,
    ) -> i32;
    fn WaitForSingleObject(handle: RawHandle, milliseconds: u32) -> u32;
    fn TerminateProcess(process: RawHandle, code: u32) -> i32;
    fn GetExitCodeProcess(process: RawHandle, code: *mut u32) -> i32;
    fn CreateJobObjectW(attributes: RawHandle, name: *const u16) -> RawHandle;
    fn AssignProcessToJobObject(job: RawHandle, process: RawHandle) -> i32;
    fn IsProcessInJob(process: RawHandle, job: RawHandle, result: *mut i32) -> i32;
    fn GetStdHandle(selector: u32) -> RawHandle;
    fn GetFileType(handle: RawHandle) -> u32;
    fn GetHandleInformation(handle: RawHandle, flags: *mut u32) -> i32;
}

pub struct Handle(RawHandle);

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn creation(raw: RawHandle) -> Result<u64, String> {
    let mut created = FileTime::default();
    let mut exited = FileTime::default();
    let mut kernel = FileTime::default();
    let mut user = FileTime::default();
    if unsafe { GetProcessTimes(raw, &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
        return Err(format!("读取创建身份失败：{}", io::Error::last_os_error()));
    }
    Ok((u64::from(created.high) << 32) | u64::from(created.low))
}

pub fn own_creation() -> Result<u64, String> {
    creation(unsafe { GetCurrentProcess() })
}

pub fn standard_handles() -> String {
    let records = [(-10_i32, "stdin"), (-11, "stdout"), (-12, "stderr")].map(|(selector, name)| {
        let raw = unsafe { GetStdHandle(selector as u32) };
        let mut flags = 0;
        let checked = unsafe { GetHandleInformation(raw, &mut flags) } != 0;
        format!("{{\"name\":\"{name}\",\"handle\":\"{}\",\"type\":{},\"flags_checked\":{checked},\"inherit\":{}}}",
            raw as usize, unsafe { GetFileType(raw) }, flags & 1 != 0)
    });
    format!("[{}]", records.join(","))
}

pub fn deny_breakaway() -> Result<Handle, String> {
    let raw = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
    if raw.is_null() {
        return Err(format!("创建夹具Job失败：{}", io::Error::last_os_error()));
    }
    let handle = Handle(raw);
    if unsafe { AssignProcessToJobObject(raw, GetCurrentProcess()) } == 0 {
        return Err(format!("加入夹具Job失败：{}", io::Error::last_os_error()));
    }
    let mut member = 0;
    if unsafe { IsProcessInJob(GetCurrentProcess(), raw, &mut member) } == 0 || member != 1 {
        return Err("未确认本进程属于本次明确Job".into());
    }
    Ok(handle)
}

pub fn ambient_job_member() -> Result<bool, String> {
    let mut member = 0;
    if unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut member) } == 0 {
        return Err("读取调用方Job归属失败".into());
    }
    Ok(member != 0)
}

pub struct OwnedProcess {
    handle: Handle,
    pub pid: u32,
    pub creation: u64,
    pub executable_verified: bool,
}

fn normalized(path: &str) -> String {
    path.trim_start_matches("\\\\?\\").to_lowercase()
}

impl OwnedProcess {
    pub fn open(
        pid: u32,
        expected_creation: u64,
        executable: &str,
    ) -> Result<Option<Self>, String> {
        let raw = unsafe { OpenProcess(0x0010_1001, 0, pid) };
        if raw.is_null() {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(87) {
                return Ok(None);
            }
            return Err(format!("打开本轮PID{pid}失败：{}", error));
        }
        let handle = Handle(raw);
        let actual = creation(raw)?;
        if actual != expected_creation {
            return Err(format!("PID{pid}创建身份不匹配，禁止回收"));
        }
        if unsafe { WaitForSingleObject(raw, 0) } == 0 {
            return Ok(Some(Self {
                handle,
                pid,
                creation: actual,
                executable_verified: false,
            }));
        }
        let mut name = [0_u16; 4096];
        let mut size = name.len() as u32;
        if unsafe { QueryFullProcessImageNameW(raw, 0, name.as_mut_ptr(), &mut size) } == 0 {
            return Err("读取本轮程序身份失败".into());
        }
        let actual_executable =
            String::from_utf16(&name[..size as usize]).map_err(|_| "程序路径无效")?;
        if normalized(&actual_executable) != normalized(executable) {
            return Err(format!("PID{pid}身份不匹配，禁止回收"));
        }
        Ok(Some(Self {
            handle,
            pid,
            creation: actual,
            executable_verified: true,
        }))
    }

    pub fn recover(&self) -> Result<(bool, u32), String> {
        let state = unsafe { WaitForSingleObject(self.handle.0, 0) };
        if state != 0 && state != 258 {
            return Err("读取本轮等待状态失败".into());
        }
        let killed = state == 258;
        if killed && unsafe { TerminateProcess(self.handle.0, 73) } == 0 {
            return Err(format!(
                "回收本轮PID{}失败：{}",
                self.pid,
                io::Error::last_os_error()
            ));
        }
        if unsafe { WaitForSingleObject(self.handle.0, 5000) } != 0 {
            return Err(format!("本轮PID{}退出未确认", self.pid));
        }
        let mut code = 0;
        if unsafe { GetExitCodeProcess(self.handle.0, &mut code) } == 0 {
            return Err("读取本轮退出码失败".into());
        }
        Ok((killed, code))
    }
}
