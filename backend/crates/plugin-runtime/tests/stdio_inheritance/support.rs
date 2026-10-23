//! 本测试后代的精确原生句柄及异常展开回收，不按历史PID强杀。
use std::{
    fs, io, mem,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::PathBuf,
    ptr,
    time::{Duration, Instant},
};
use windows_sys::Win32::System::{
    JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    },
    Threading::{OpenProcess, WaitForSingleObject},
};

pub(super) struct Descendant {
    pub root: PathBuf,
    handle: Option<OwnedHandle>,
    pub pid: Option<u32>,
    completed: bool,
    job: OwnedHandle,
}

impl Descendant {
    pub fn new(root: PathBuf) -> Self {
        let raw = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        assert!(!raw.is_null(), "创建本测试进程树");
        let job = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        assert_ne!(
            unsafe {
                SetInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    mem::size_of_val(&limits) as u32,
                )
            },
            0,
            "设置异常关闭回收"
        );
        Self {
            root,
            handle: None,
            pid: None,
            completed: false,
            job,
        }
    }

    pub fn assign(&self, child: &tokio::process::Child) {
        // 插件仍等待首帧，此时尚不可能派生业务后代；先归属再允许协议开始。
        let raw = child.raw_handle().expect("新插件的真实句柄");
        assert_ne!(
            unsafe { AssignProcessToJobObject(self.job.as_raw_handle(), raw) },
            0,
            "测试插件必须归属本轮进程树"
        );
    }

    fn empty(&self) -> Result<bool, String> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { mem::zeroed() };
        if unsafe {
            QueryInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                mem::size_of_val(&info) as u32,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error().to_string());
        }
        Ok(info.ActiveProcesses == 0)
    }

    pub fn observe(&mut self) -> Result<(), String> {
        let pid = fs::read_to_string(self.root.join("descendant.pid"))
            .map_err(|error| error.to_string())?
            .parse::<u32>()
            .map_err(|error| error.to_string())?;
        // 仅请求等待权，持有本次真实进程句柄直至确认退出，避免PID复用误判。
        let handle = unsafe { OpenProcess(0x0010_0000, 0, pid) };
        if handle.is_null() {
            return Err(io::Error::last_os_error().to_string());
        }
        self.handle = Some(unsafe { OwnedHandle::from_raw_handle(handle) });
        self.pid = Some(pid);
        self.require_running()
    }

    pub fn require_running(&self) -> Result<(), String> {
        let handle = self.handle.as_ref().ok_or("后代尚未观测")?;
        if unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } != 258 {
            return Err("验证期间后代必须真实存活".into());
        }
        Ok(())
    }

    pub fn finish(&mut self) -> Result<(), String> {
        if self.completed {
            return Ok(());
        }
        fs::write(self.root.join("release"), b"release").map_err(|error| error.to_string())?;
        let graceful = Instant::now() + Duration::from_secs(1);
        let deadline = graceful + Duration::from_secs(4);
        let mut forced = false;
        loop {
            let exited = self.handle.as_ref().is_none_or(
                |handle| unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } == 0,
            );
            // 没有PID文件不表示未启动：始终验证已归属的整个原生进程树归零。
            if exited && self.empty()? {
                break;
            }
            if Instant::now() >= graceful && !forced {
                forced = true;
                if unsafe { TerminateJobObject(self.job.as_raw_handle(), 73) } == 0 {
                    return Err(io::Error::last_os_error().to_string());
                }
            }
            if Instant::now() >= deadline {
                return Err("本轮进程树仍未确认清空".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        self.handle.take();
        self.completed = true;
        if forced {
            Err("本轮进程树已兜底回收，但没有正常退出".into())
        } else {
            Ok(())
        }
    }
}

impl Drop for Descendant {
    fn drop(&mut self) {
        // 断言或解析panic同样释放后代；无法确认则显式报告，不把标记当退出。
        if let Err(error) = self.finish() {
            eprintln!("本轮后代回收异常：{error}，目录={}", self.root.display());
        }
    }
}
