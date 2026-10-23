use super::super::PtySize;
use super::launch::Specification;
use crate::{Error, Result, ownership::Lease, scoped::windows::Scope};
use std::{
    fs::File,
    io, mem,
    os::windows::{io::AsRawHandle, process::ExitStatusExt},
    process::ExitStatus,
    ptr,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::{
        Console::{COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole},
        Threading::{
            CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
            DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
            InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, ResumeThread,
            STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute,
            WaitForSingleObject,
        },
    },
};

struct Handle(HANDLE);
unsafe impl Send for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub(super) struct Console(HPCON);
impl Console {
    pub(super) fn close(self) {
        unsafe {
            ClosePseudoConsole(self.0);
        }
        std::mem::forget(self);
    }
}
impl Drop for Console {
    fn drop(&mut self) {
        // ClosePseudoConsole可能等待末尾输出，不在异步调度线程调用。
        let value = self.0;
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn_blocking(move || unsafe {
                ClosePseudoConsole(value);
            });
        } else {
            if std::thread::Builder::new()
                .name("deviceforge-pty-close".into())
                .spawn(move || unsafe {
                    ClosePseudoConsole(value);
                })
                .is_err()
            {
                // 运行时已消失且操作系统拒绝线程时，只能在析构线程完成最终关闭。
                unsafe {
                    ClosePseudoConsole(value);
                }
            }
        }
    }
}

struct Attributes {
    _storage: Vec<usize>,
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl Attributes {
    fn new(console: HPCON) -> Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut bytes);
        }
        let mut storage = vec![0usize; bytes.div_ceil(mem::size_of::<usize>())];
        let list = storage.as_mut_ptr().cast();
        if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut bytes) } == 0 {
            return Err(Error::ProcessIo(io::Error::last_os_error()));
        }
        let result = Self {
            _storage: storage,
            list,
        };
        if unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                console as *const _,
                mem::size_of::<HPCON>(),
                ptr::null_mut(),
                ptr::null(),
            )
        } == 0
        {
            return Err(Error::ProcessIo(io::Error::last_os_error()));
        }
        Ok(result)
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.list);
        }
    }
}

pub(super) struct Owner {
    process: Option<Handle>,
    scope: Option<Scope>,
    console: Option<Console>,
    lease: Option<Lease>,
    confirmed: bool,
}

impl Owner {
    pub(super) fn launch(
        mut spec: Specification,
        size: PtySize,
        input: &File,
        output: &File,
        lease: Lease,
        options: &crate::ExecutionOptions,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<(Self, Option<Error>)> {
        let scope = Scope::new()?;
        let mut console = 0;
        let result = unsafe {
            CreatePseudoConsole(
                coord(size),
                input.as_raw_handle(),
                output.as_raw_handle(),
                0,
                &mut console,
            )
        };
        if result < 0 {
            return Err(Error::Spawn(io::Error::from_raw_os_error(result)));
        }
        let mut owner = Self {
            process: None,
            scope: Some(scope),
            console: Some(Console(console)),
            lease: Some(lease),
            confirmed: false,
        };
        // 创建PTY后的任何失败都交回异步监督器，继续排空管道并确认关闭。
        let launched: Result<()> = (|| {
            let attributes = Attributes::new(console)?;
            let mut startup: STARTUPINFOEXW = unsafe { mem::zeroed() };
            startup.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
            // 父进程标准流被Cargo/插件管道重定向时，Windows仍可能复制这些句柄。
            // 显式空标准句柄阻止该兼容路径，让ConPTY为新控制台提供真正的TTY。
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = ptr::null_mut();
            startup.StartupInfo.hStdOutput = ptr::null_mut();
            startup.StartupInfo.hStdError = ptr::null_mut();
            startup.lpAttributeList = attributes.list;
            let mut process: PROCESS_INFORMATION = unsafe { mem::zeroed() };
            if unsafe {
                CreateProcessW(
                    ptr::null(),
                    spec.command.as_mut_ptr(),
                    ptr::null(),
                    ptr::null(),
                    0,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                    spec.environment.as_ptr().cast(),
                    spec.directory
                        .as_ref()
                        .map_or(ptr::null(), |value| value.as_ptr()),
                    &startup.StartupInfo,
                    &mut process,
                )
            } == 0
            {
                return Err(Error::Spawn(io::Error::last_os_error()));
            }
            owner.process = Some(Handle(process.hProcess));
            let thread = Handle(process.hThread);
            owner
                .scope
                .as_mut()
                .expect("新建进程树")
                .assign_handle(process.hProcess)?;
            crate::lifecycle::preflight(options, cancel)?;
            if unsafe { ResumeThread(thread.0) } != 1 {
                return Err(Error::Spawn(io::Error::last_os_error()));
            }
            Ok(())
        })();
        Ok((owner, launched.err()))
    }

    pub(super) fn status(&self) -> Result<Option<ExitStatus>> {
        let Some(process) = self.process.as_ref() else {
            return Ok(None);
        };
        match unsafe { WaitForSingleObject(process.0, 0) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 {
                    return Err(Error::ProcessIo(io::Error::last_os_error()));
                }
                Ok(Some(ExitStatus::from_raw(code)))
            }
            _ => Err(Error::ProcessIo(io::Error::last_os_error())),
        }
    }

    pub(super) fn resize(&self, size: PtySize) -> Result<()> {
        let console = self
            .console
            .as_ref()
            .ok_or(Error::InvalidOptions("终端已关闭"))?;
        let result = unsafe { ResizePseudoConsole(console.0, coord(size)) };
        if result < 0 {
            return Err(Error::ProcessIo(io::Error::from_raw_os_error(result)));
        }
        Ok(())
    }

    pub(super) fn stop(&self) -> Result<()> {
        let scope = self.scope.as_ref().expect("保留原生进程树");
        let assigned = scope.assigned();
        let scope_result = scope.stop();
        // 已归属进程由Job统一终止，避免对正在退出的根进程重复终止。
        // 归属Job之前失败的暂停进程仍由本次持有的精确句柄终止。
        let root = match &self.process {
            Some(_) if assigned => Ok(()),
            Some(process) => match unsafe { WaitForSingleObject(process.0, 0) } {
                WAIT_OBJECT_0 => Ok(()),
                WAIT_TIMEOUT if unsafe { TerminateProcess(process.0, 73) } != 0 => Ok(()),
                WAIT_TIMEOUT if unsafe { WaitForSingleObject(process.0, 0) } == WAIT_OBJECT_0 => {
                    Ok(())
                }
                _ => Err(Error::ProcessIo(io::Error::last_os_error())),
            },
            None => Ok(()),
        };
        scope_result.and(root)
    }
    pub(super) fn unstarted(&self) -> bool {
        self.process.is_none()
    }
    pub(super) fn empty(&mut self) -> Result<bool> {
        self.scope.as_mut().expect("保留原生进程树").empty()
    }
    pub(super) fn console(&mut self) -> Option<Console> {
        self.console.take()
    }
    pub(super) fn confirmed(&mut self) {
        self.confirmed = true;
        self.process.take();
        self.scope.take();
        self.lease.take();
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        if self.confirmed {
            return;
        }
        let _ = self.stop();
        // 未确认的资源租约保持粘性，不能因回收器被运行时丢弃而宣布完成。
        if let Some(lease) = self.lease.take() {
            std::mem::forget(lease);
        }
    }
}

fn coord(size: PtySize) -> COORD {
    COORD {
        X: size.cols as i16,
        Y: size.rows as i16,
    }
}
