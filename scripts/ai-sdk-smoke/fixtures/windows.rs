use std::{ffi::c_void, mem};

#[repr(C)]
struct FileTime {
    low: u32,
    high: u32,
}

#[repr(C)]
struct ProcessEntry {
    size: u32,
    usage: u32,
    pid: u32,
    heap: usize,
    module: u32,
    threads: u32,
    parent_pid: u32,
    priority: i32,
    flags: u32,
    filename: [u16; 260],
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
    fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry) -> i32;
    fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn GetProcessTimes(
        handle: *mut c_void,
        creation: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
    fn QueryFullProcessImageNameW(
        handle: *mut c_void,
        flags: u32,
        path: *mut u16,
        length: *mut u32,
    ) -> i32;
}

pub struct Identity {
    pub pid: u32,
    pub parent_pid: u32,
    pub creation: u64,
    pub executable: String,
}

fn entries() -> Result<Vec<(u32, u32)>, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(2, 0) };
    if snapshot.is_null() || snapshot == usize::MAX as *mut c_void {
        return Err("获取真实进程快照失败".into());
    }
    let mut entry: ProcessEntry = unsafe { mem::zeroed() };
    entry.size = mem::size_of::<ProcessEntry>() as u32;
    let mut found = Vec::new();
    let mut available = unsafe { Process32FirstW(snapshot, &mut entry) };
    while available != 0 {
        found.push((entry.pid, entry.parent_pid));
        available = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot) };
    Ok(found)
}

fn identity(pid: u32, parent_pid: u32) -> Result<Identity, String> {
    let handle = unsafe { OpenProcess(0x1000, 0, pid) };
    if handle.is_null() {
        return Err("获取本轮真实进程身份失败".into());
    }
    let result = (|| {
        let mut created: FileTime = unsafe { mem::zeroed() };
        let mut exited: FileTime = unsafe { mem::zeroed() };
        let mut kernel: FileTime = unsafe { mem::zeroed() };
        let mut user: FileTime = unsafe { mem::zeroed() };
        if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }
            == 0
        {
            return Err("读取真实创建时间失败".into());
        }
        let mut path = [0_u16; 4096];
        let mut length = path.len() as u32;
        if unsafe { QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut length) } == 0 {
            return Err("读取真实程序入口失败".into());
        }
        Ok(Identity {
            pid,
            parent_pid,
            creation: (u64::from(created.high) << 32) | u64::from(created.low),
            executable: String::from_utf16(&path[..length as usize]).map_err(|_| "程序路径无效")?,
        })
    })();
    unsafe { CloseHandle(handle) };
    result
}

pub fn own() -> Result<Identity, String> {
    let pid = std::process::id();
    let parent = entries()?
        .into_iter()
        .find_map(|(candidate, parent)| (candidate == pid).then_some(parent))
        .ok_or("未找到真实直接父进程")?;
    identity(pid, parent)
}

pub fn family(owner_pid: u32) -> Result<Vec<Identity>, String> {
    let entries = entries()?;
    let mut selected = vec![owner_pid];
    loop {
        let before = selected.len();
        for &(pid, parent) in &entries {
            if selected.contains(&parent) && !selected.contains(&pid) {
                selected.push(pid);
            }
        }
        if selected.len() == before {
            break;
        }
        if selected.len() > 32 {
            return Err("本轮进程族成员超限".into());
        }
    }
    entries
        .into_iter()
        .filter(|(pid, _)| selected.contains(pid))
        .map(|(pid, parent)| identity(pid, parent))
        .collect()
}
