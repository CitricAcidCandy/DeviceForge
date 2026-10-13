use super::{Launch, NodeExit, OutputReader};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs::File,
    os::fd::{AsRawFd, FromRawFd},
};

#[path = "darwin_spawn.rs"]
mod spawn;

const MEMBER_LIMIT: usize = 256;

pub struct Scope {
    node: spawn::Child,
    sentinel: spawn::Child,
    queue: File,
    tracked: BTreeSet<i32>,
    stopped: bool,
    empty: bool,
    sentinel_exit_seen: bool,
}

fn members(group: i32) -> Result<Vec<i32>, String> {
    let mut values = [0i32; MEMBER_LIMIT];
    let capacity = std::mem::size_of_val(&values) as i32;
    let count =
        unsafe { libc::proc_listpids(2, group as u32, values.as_mut_ptr().cast(), capacity) };
    if count < 0 || count >= capacity || count % std::mem::size_of::<i32>() as i32 != 0 {
        return Err("SDK原生进程组成员查询失败或超限".into());
    }
    let mut result = Vec::new();
    for pid in &values[..count as usize / std::mem::size_of::<i32>()] {
        if *pid <= 0 {
            return Err("SDK原生进程组成员标识无效".into());
        }
        result.push(*pid);
    }
    Ok(result)
}

fn watch(queue: &File, pid: i32) -> Result<(), String> {
    let change = libc::kevent {
        ident: pid as usize,
        filter: libc::EVFILT_PROC,
        flags: libc::EV_ADD | libc::EV_CLEAR,
        fflags: libc::NOTE_FORK | libc::NOTE_EXIT,
        data: 0,
        udata: std::ptr::null_mut(),
    };
    if unsafe {
        libc::kevent(
            queue.as_raw_fd(),
            &change,
            1,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
        )
    } != 0
    {
        return Err("SDK原生进程身份登记失败".into());
    }
    Ok(())
}

impl Scope {
    pub fn start(launch: &Launch) -> Result<Self, String> {
        let descriptor = unsafe { libc::kqueue() };
        if descriptor < 0 {
            return Err("SDK原生kqueue创建失败".into());
        }
        let queue = unsafe { File::from_raw_fd(descriptor) };
        if unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return Err("SDK原生kqueue继承配置失败".into());
        }
        let executable = std::env::current_exe().map_err(|_| "SDK原生sentinel入口不可用")?;
        let sentinel = spawn::Child::spawn(
            &executable,
            &[OsString::from("--sdk-sentinel")],
            &BTreeMap::new(),
            0,
            true,
        )?;
        watch(&queue, sentinel.pid)?;
        let node = spawn::Child::spawn(
            &launch.node,
            &[launch.worker.as_os_str().into()],
            &launch.environment,
            sentinel.pid,
            false,
        )?;
        watch(&queue, node.pid)?;
        let tracked = BTreeSet::from([sentinel.pid, node.pid]);
        let scope = Self {
            node,
            sentinel,
            queue,
            tracked,
            stopped: false,
            empty: false,
            sentinel_exit_seen: false,
        };
        scope.sentinel.resume()?;
        scope.node.resume()?;
        Ok(scope)
    }

    pub fn id(&self) -> u32 {
        self.node.pid as u32
    }
    pub fn take_stdout(&mut self) -> Option<OutputReader> {
        self.node.stdout.take()
    }
    pub fn take_stderr(&mut self) -> Option<OutputReader> {
        self.node.stderr.take()
    }

    fn events(&mut self) -> Result<(), String> {
        let mut events: [libc::kevent; 32] = unsafe { std::mem::zeroed() };
        let timeout = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        let count = unsafe {
            libc::kevent(
                self.queue.as_raw_fd(),
                std::ptr::null(),
                0,
                events.as_mut_ptr(),
                events.len() as i32,
                &timeout,
            )
        };
        if count < 0 {
            return Err("SDK原生进程事件查询失败".into());
        }
        for event in &events[..count as usize] {
            let pid = event.ident as i32;
            let flags = event.flags;
            let notes = event.fflags;
            if flags & libc::EV_ERROR != 0 || !self.tracked.contains(&pid) {
                return Err("SDK原生进程事件身份无效".into());
            }
            if pid == self.sentinel.pid && notes & libc::NOTE_EXIT != 0 {
                self.sentinel_exit_seen = true;
            }
            if pid == self.sentinel.pid && notes & libc::NOTE_FORK != 0 {
                return Err("SDK原生sentinel出现非预期后代".into());
            }
        }
        if self.sentinel_exit_seen && !self.stopped && self.sentinel.input.is_some() {
            return Err("SDK原生进程组身份提前退出".into());
        }
        Ok(())
    }

    fn current(&mut self) -> Result<Vec<i32>, String> {
        if self.empty {
            return Ok(Vec::new());
        }
        let current = members(self.sentinel.pid)?;
        if current.len() > 3 {
            return Err("SDK受控worker和单代理成员数量超限".into());
        }
        for pid in &current {
            if !self.tracked.contains(pid) {
                if self.tracked.len() >= 3 {
                    return Err("SDK受控代理成员重复或未知".into());
                }
                watch(&self.queue, *pid)?;
                self.tracked.insert(*pid);
            }
        }
        Ok(current)
    }

    pub fn poll(&mut self) -> Result<Option<NodeExit>, String> {
        self.events()?;
        self.current()?;
        self.node.poll()
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if !self.stopped && !self.empty {
            if self.sentinel.exit.is_some() {
                return Err("SDK原生进程组身份已释放".into());
            }
            self.stopped = true;
            if unsafe { libc::kill(-self.sentinel.pid, libc::SIGKILL) } != 0 {
                return Err("SDK原生受控进程组停止失败".into());
            }
        }
        Ok(())
    }

    pub fn complete(&mut self) -> Result<bool, String> {
        if self.node.poll()?.is_none() {
            return Ok(false);
        }
        if self.empty {
            return Ok(true);
        }
        let current = self.current()?;
        if current.iter().all(|pid| *pid == self.sentinel.pid) {
            self.sentinel.input.take();
            if self.sentinel.poll()?.is_some() {
                self.empty = true;
            }
        }
        Ok(self.empty)
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        if !self.empty && !self.stopped {
            let _ = self.stop();
        }
    }
}
