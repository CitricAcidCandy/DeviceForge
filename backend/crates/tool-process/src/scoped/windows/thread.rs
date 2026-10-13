use super::Handle;
use crate::{Error, ExecutionOptions, Result};
use std::{io, mem};
use tokio_util::sync::CancellationToken;
use windows_sys::Win32::{
    Foundation::ERROR_NO_MORE_FILES,
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
        },
        Threading::{
            GetProcessIdOfThread, OpenThread, ResumeThread, THREAD_QUERY_LIMITED_INFORMATION,
            THREAD_SUSPEND_RESUME,
        },
    },
};

pub(super) fn resume(
    pid: u32,
    options: &ExecutionOptions,
    cancel: &CancellationToken,
) -> Result<()> {
    let snapshot = Handle::new(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })?;
    let mut entry: THREADENTRY32 = unsafe { mem::zeroed() };
    entry.dwSize = mem::size_of_val(&entry) as u32;
    let mut available = unsafe { Thread32First(snapshot.0, &mut entry) };
    let mut initial = None;
    while available != 0 {
        if entry.th32OwnerProcessID == pid && initial.replace(entry.th32ThreadID).is_some() {
            return Err(Error::ProcessIo(io::Error::other("暂停工具初始线程不唯一")));
        }
        entry.dwSize = mem::size_of_val(&entry) as u32;
        available = unsafe { Thread32Next(snapshot.0, &mut entry) };
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
        return Err(Error::ProcessIo(error));
    }
    let thread_id =
        initial.ok_or_else(|| Error::ProcessIo(io::Error::other("没有找到暂停工具初始线程")))?;
    let thread = Handle::new(unsafe {
        OpenThread(
            THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
            0,
            thread_id,
        )
    })?;
    if unsafe { GetProcessIdOfThread(thread.0) } != pid {
        return Err(Error::ProcessIo(io::Error::other("暂停工具线程归属不匹配")));
    }
    crate::lifecycle::preflight(options, cancel)?;
    let previous = unsafe { ResumeThread(thread.0) };
    if previous != 1 {
        return Err(Error::ProcessIo(if previous == u32::MAX {
            io::Error::last_os_error()
        } else {
            io::Error::other("工具初始线程挂起计数不匹配")
        }));
    }
    Ok(())
}
