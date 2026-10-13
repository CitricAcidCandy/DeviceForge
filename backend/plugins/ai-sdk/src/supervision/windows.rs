use super::{Launch, NodeExit, OutputReader};
use std::{
    ffi::c_void,
    mem::size_of,
    os::windows::{io::AsRawHandle, process::CommandExt},
    process::Child,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
            JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
            TerminateJobObject,
        },
        Threading::{
            CREATE_NO_WINDOW, CREATE_SUSPENDED, GetCurrentProcess, OpenThread, ResumeThread,
            THREAD_SUSPEND_RESUME,
        },
    },
};

fn os_error(message: &str) -> String {
    format!("{message}: {}", std::io::Error::last_os_error())
}

#[repr(C)]
struct ThreadEntry {
    size: u32,
    usage: u32,
    thread_id: u32,
    process_id: u32,
    base_priority: i32,
    delta_priority: i32,
    flags: u32,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, process: u32) -> HANDLE;
    fn Thread32First(snapshot: HANDLE, entry: *mut ThreadEntry) -> i32;
    fn Thread32Next(snapshot: HANDLE, entry: *mut ThreadEntry) -> i32;
}

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

fn resume_primary(process_id: u32) -> Result<(), String> {
    let snapshot = Handle(unsafe { CreateToolhelp32Snapshot(4, 0) });
    if snapshot.0 == INVALID_HANDLE_VALUE {
        return Err("SDK原生线程快照失败".into());
    }
    let mut entry = ThreadEntry {
        size: size_of::<ThreadEntry>() as u32,
        usage: 0,
        thread_id: 0,
        process_id: 0,
        base_priority: 0,
        delta_priority: 0,
        flags: 0,
    };
    let mut found = Vec::new();
    let mut available = unsafe { Thread32First(snapshot.0, &mut entry) } != 0;
    while available {
        if entry.process_id == process_id {
            found.push(entry.thread_id);
        }
        available = unsafe { Thread32Next(snapshot.0, &mut entry) } != 0;
    }
    if found.len() != 1 {
        return Err("SDK启动前主线程资格不确定".into());
    }
    let thread = Handle(unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, found[0]) });
    if thread.0.is_null() || unsafe { ResumeThread(thread.0) } != 1 {
        return Err("SDK主线程恢复失败".into());
    }
    Ok(())
}

pub struct Scope {
    job: Option<Handle>,
    child: Child,
    exit: Option<NodeExit>,
    stopped: bool,
}

fn inherited_job() -> bool {
    let mut in_job = 0;
    (unsafe { IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job) != 0 })
        && in_job != 0
}

impl Scope {
    pub fn start(launch: &Launch) -> Result<Self, String> {
        let job = if inherited_job() {
            None
        } else {
            let job = Handle(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) });
            if job.0.is_null() {
                return Err(os_error("SDK原生Job创建失败"));
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const c_void,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            } == 0
            {
                return Err(os_error("SDK原生Job配置失败"));
            }
            Some(job)
        };
        let mut command = launch.command();
        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
        let mut child = command
            .spawn()
            .map_err(|error| format!("SDK原生Node启动失败: {error}"))?;
        if let Some(job) = &job
            && unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) } == 0
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(os_error("SDK启动前Job归属绑定失败"));
        }
        if let Err(error) = resume_primary(child.id()) {
            if let Some(job) = &job {
                unsafe {
                    TerminateJobObject(job.0, 1);
                }
            }
            let _ = child.wait();
            return Err(error);
        }
        Ok(Self {
            job,
            child,
            exit: None,
            stopped: false,
        })
    }

    pub fn id(&self) -> u32 {
        self.child.id()
    }
    pub fn take_stdout(&mut self) -> Option<OutputReader> {
        self.child
            .stdout
            .take()
            .map(|reader| Box::new(reader) as OutputReader)
    }
    pub fn take_stderr(&mut self) -> Option<OutputReader> {
        self.child
            .stderr
            .take()
            .map(|reader| Box::new(reader) as OutputReader)
    }

    pub fn poll(&mut self) -> Result<Option<NodeExit>, String> {
        if self.exit.is_none() {
            self.exit = self
                .child
                .try_wait()
                .map_err(|_| "SDK原生Node退出查询失败")?
                .map(|status| NodeExit {
                    code: status.code(),
                    signal: None,
                });
        }
        Ok(self.exit.clone())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if !self.stopped {
            self.stopped = true;
            if let Some(job) = &self.job
                && unsafe { TerminateJobObject(job.0, 1) } == 0
            {
                return Err(os_error("SDK原生Job停止失败"));
            }
        }
        Ok(())
    }

    pub fn complete(&mut self) -> Result<bool, String> {
        if self.poll()?.is_none() {
            return Ok(false);
        }
        let Some(job) = &self.job else {
            return Ok(self.poll()?.is_some());
        };
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe {
            QueryInformationJobObject(
                job.0,
                JobObjectBasicAccountingInformation,
                &mut accounting as *mut _ as *mut c_void,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(os_error("SDK原生Job成员查询失败"));
        }
        Ok(accounting.ActiveProcesses == 0)
    }
}
