//! 本机进程出生身份及遗留直接子进程审计；不按裸 PID 发送信号。
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Identity {
    pub pid: u32,
    pub birth: String,
}

pub(crate) fn current() -> Result<Identity, String> {
    let pid = std::process::id();
    let birth = native::birth(pid)?.ok_or("无法取得投屏进程出生身份")?;
    Ok(Identity { pid, birth })
}

pub(super) fn quiescent(owner: &Identity) -> Result<bool, String> {
    if native::birth(owner.pid)?.as_deref() == Some(owner.birth.as_str()) {
        return Ok(false);
    }
    native::children_gone(owner)
}

pub(super) fn alive(owner: &Identity) -> Result<bool, String> {
    Ok(native::birth(owner.pid)?.as_deref() == Some(owner.birth.as_str()))
}

#[cfg(windows)]
mod native {
    use super::Identity;
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    struct Entry {
        size: u32,
        usage: u32,
        pid: u32,
        heap: usize,
        module: u32,
        threads: u32,
        parent: u32,
        priority: i32,
        flags: u32,
        executable: [u16; 260],
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetLastError() -> u32;
        fn GetProcessTimes(
            handle: Handle,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn WaitForSingleObject(handle: Handle, timeout: u32) -> u32;
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut Entry) -> i32;
        fn Process32NextW(snapshot: Handle, entry: *mut Entry) -> i32;
    }
    struct Owned(Handle);
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub(super) fn birth(pid: u32) -> Result<Option<String>, String> {
        let handle = unsafe { OpenProcess(0x0010_1000, 0, pid) };
        if handle.is_null() {
            return if unsafe { GetLastError() } == 87 {
                Ok(None)
            } else {
                Err("无法核对本机直接进程身份".into())
            };
        }
        let handle = Owned(handle);
        match unsafe { WaitForSingleObject(handle.0, 0) } {
            0 => return Ok(None),
            258 => {}
            _ => return Err("无法确认本机直接进程状态".into()),
        }
        let mut creation = FileTime::default();
        let mut exit = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        if unsafe { GetProcessTimes(handle.0, &mut creation, &mut exit, &mut kernel, &mut user) }
            == 0
        {
            return Err("无法读取本机进程出生身份".into());
        }
        Ok(Some(
            ((u64::from(creation.high) << 32) | u64::from(creation.low)).to_string(),
        ))
    }

    pub(super) fn children_gone(owner: &Identity) -> Result<bool, String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(2, 0) };
        if snapshot as isize == -1 {
            return Err("无法审计旧投屏直接子进程".into());
        }
        let snapshot = Owned(snapshot);
        // 系统结构先清零，再设置尺寸；快照句柄始终由作用域回收。
        let mut entry: Entry = unsafe { std::mem::zeroed() };
        entry.size = std::mem::size_of::<Entry>() as u32;
        let mut next = unsafe { Process32FirstW(snapshot.0, &mut entry) };
        let parent_birth = owner
            .birth
            .parse::<u64>()
            .map_err(|_| "本机进程台账身份无效")?;
        let mut count = 0;
        while next != 0 {
            count += 1;
            if count > 32768 {
                return Err("本机进程审计超限".into());
            }
            if entry.parent == owner.pid
                && let Some(birth) = birth(entry.pid)?
                && birth.parse::<u64>().map_err(|_| "直接子进程出生身份无效")? >= parent_birth
            {
                return Ok(false);
            }
            next = unsafe { Process32NextW(snapshot.0, &mut entry) };
        }
        if unsafe { GetLastError() } != 18 {
            return Err("本机进程审计未完成".into());
        }
        Ok(true)
    }
}

#[cfg(not(windows))]
mod native {
    use super::Identity;
    pub(super) fn birth(pid: u32) -> Result<Option<String>, String> {
        #[cfg(target_os = "linux")]
        {
            let text = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
                Ok(text) => text,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err("无法核对本机进程身份".into()),
            };
            let fields: Vec<_> = text
                .rsplit_once(')')
                .ok_or("本机进程身份无效")?
                .1
                .split_whitespace()
                .collect();
            let start = fields.get(19).ok_or("本机进程出生身份缺失")?;
            let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
                .map_err(|_| "无法核对本机启动身份")?;
            Ok(Some(format!("{}:{start}", boot.trim())))
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = pid;
            Err("当前平台尚不能核对本机进程出生身份".into())
        }
    }
    pub(super) fn children_gone(_: &Identity) -> Result<bool, String> {
        // 父进程退出后子进程可能被重新托管，不能以父 PID 缺失假装证明子进程已退出。
        Err("当前平台尚不能证明崩溃后的直接子进程全部退出".into())
    }
}
