mod thread;

use crate::{Error, ExecutionOptions, Result};
use std::{io, mem, ptr};
use tokio::process::Child;
use tokio_util::sync::CancellationToken;
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT},
    System::{
        IO::{CreateIoCompletionPort, GetQueuedCompletionStatus},
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_ASSOCIATE_COMPLETION_PORT,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JobObjectAssociateCompletionPortInformation, JobObjectBasicAccountingInformation,
            JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
            TerminateJobObject,
        },
        SystemServices::JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO,
        Threading::CREATE_SUSPENDED,
    },
};

pub(super) const CREATION_FLAGS: u32 = CREATE_SUSPENDED | 0x08000000;

pub(super) struct Handle(HANDLE);

unsafe impl Send for Handle {}

impl Handle {
    fn new(raw: HANDLE) -> Result<Self> {
        if raw.is_null() || raw == INVALID_HANDLE_VALUE {
            return Err(Error::ProcessIo(io::Error::last_os_error()));
        }
        Ok(Self(raw))
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub(super) struct Scope {
    job: Handle,
    port: Handle,
    assigned: bool,
    observed_zero: bool,
}

impl Scope {
    pub(super) fn new() -> Result<Self> {
        let job = Handle::new(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) })?;
        let port = Handle::new(unsafe {
            CreateIoCompletionPort(INVALID_HANDLE_VALUE, ptr::null_mut(), 0, 1)
        })?;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(Error::ProcessIo(io::Error::last_os_error()));
        }
        let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: job.0,
            CompletionPort: port.0,
        };
        if unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectAssociateCompletionPortInformation,
                (&association as *const JOBOBJECT_ASSOCIATE_COMPLETION_PORT).cast(),
                mem::size_of_val(&association) as u32,
            )
        } == 0
        {
            return Err(Error::ProcessIo(io::Error::last_os_error()));
        }
        Ok(Self {
            job,
            port,
            assigned: false,
            observed_zero: false,
        })
    }

    pub(super) fn assign(&mut self, child: &Child) -> Result<()> {
        let raw = child
            .raw_handle()
            .ok_or_else(|| Error::ProcessIo(io::Error::other("暂停工具没有实际进程句柄")))?;
        if unsafe { AssignProcessToJobObject(self.job.0, raw) } == 0 {
            return Err(Error::ProcessIo(io::Error::last_os_error()));
        }
        self.assigned = true;
        let mut member = 0;
        if unsafe { IsProcessInJob(raw, self.job.0, &mut member) } == 0 {
            return Err(Error::ProcessIo(io::Error::last_os_error()));
        }
        if member != 1 {
            return Err(Error::ProcessIo(io::Error::other(
                "未确认工具属于本调用Job",
            )));
        }
        Ok(())
    }

    pub(super) fn resume(
        &self,
        child: &Child,
        options: &ExecutionOptions,
        cancel: &CancellationToken,
    ) -> Result<()> {
        if !self.assigned {
            return Err(Error::ProcessIo(io::Error::other("禁止恢复未归属工具")));
        }
        let pid = child
            .id()
            .ok_or_else(|| Error::ProcessIo(io::Error::other("暂停工具没有进程身份")))?;
        thread::resume(pid, options, cancel)
    }

    pub(super) fn stop(&self) -> Result<()> {
        if unsafe { TerminateJobObject(self.job.0, 73) } == 0 {
            return Err(Error::ProcessIo(io::Error::last_os_error()));
        }
        Ok(())
    }

    pub(super) fn empty(&mut self) -> Result<bool> {
        for _ in 0..64 {
            let mut message = 0;
            let mut key = 0;
            let mut overlapped = ptr::null_mut();
            if unsafe {
                GetQueuedCompletionStatus(self.port.0, &mut message, &mut key, &mut overlapped, 0)
            } == 0
            {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(WAIT_TIMEOUT as i32) {
                    break;
                }
                return Err(Error::ProcessIo(error));
            }
            if key != self.job.0 as usize {
                return Err(Error::ProcessIo(io::Error::other("Job监督回执归属不匹配")));
            }
            if message == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO {
                self.observed_zero = true;
            }
        }
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { mem::zeroed() };
        if unsafe {
            QueryInformationJobObject(
                self.job.0,
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                mem::size_of_val(&accounting) as u32,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(Error::ProcessIo(io::Error::last_os_error()));
        }
        Ok(accounting.ActiveProcesses == 0 && (!self.assigned || self.observed_zero))
    }
}
