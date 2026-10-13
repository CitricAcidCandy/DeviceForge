use super::{Launch, NodeExit, OutputReader};
use std::{
    fs::File,
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::process::CommandExt,
    },
    process::{Child, Stdio},
};

pub struct Scope {
    node: Child,
    sentinel: Child,
    node_identity: File,
    sentinel_identity: File,
    exit: Option<NodeExit>,
    sentinel_exited: bool,
    stopped: bool,
    empty: bool,
    group: i32,
}

fn identity(process: &Child) -> Result<File, String> {
    let descriptor = unsafe { libc::syscall(libc::SYS_pidfd_open, process.id(), 0) };
    if descriptor < 0 {
        return Err("SDK私有监督pidfd出生身份不可用".into());
    }
    Ok(unsafe { File::from_raw_fd(descriptor as i32) })
}

fn exited(identity: &File) -> Result<bool, String> {
    let mut descriptor = libc::pollfd {
        fd: identity.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    loop {
        let count = unsafe { libc::poll(&mut descriptor, 1, 0) };
        if count >= 0 {
            if descriptor.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
                return Err("SDK私有监督pidfd实际退出查询失败".into());
            }
            return Ok(descriptor.revents & (libc::POLLIN | libc::POLLHUP) != 0);
        }
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return Err("SDK私有监督pidfd实际退出查询失败".into());
        }
    }
}

fn children() -> Result<Vec<i32>, String> {
    let file = File::open(format!("/proc/self/task/{}/children", std::process::id()))
        .map_err(|_| "SDK私有监督成员查询失败")?;
    let mut bytes = Vec::new();
    file.take(8193)
        .read_to_end(&mut bytes)
        .map_err(|_| "SDK私有监督成员查询失败")?;
    if bytes.len() > 8192 {
        return Err("SDK私有监督成员查询超限".into());
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "SDK私有监督成员查询无效")?;
    text.split_whitespace()
        .map(|value| {
            value
                .parse::<i32>()
                .ok()
                .filter(|pid| *pid > 0)
                .ok_or_else(|| "SDK私有监督成员标识无效".into())
        })
        .collect()
}

impl Scope {
    pub fn start(launch: &Launch) -> Result<Self, String> {
        if unsafe { libc::syscall(libc::SYS_gettid) } != unsafe { libc::getpid() } as libc::c_long {
            return Err("SDK私有监督必须在独立进程主线程运行".into());
        }
        if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
            return Err("SDK私有subreaper设置失败".into());
        }
        let executable = std::env::current_exe().map_err(|_| "SDK私有sentinel入口不可用")?;
        let mut sentinel_command = std::process::Command::new(executable);
        sentinel_command
            .arg("--sdk-sentinel")
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            sentinel_command.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut sentinel = sentinel_command
            .spawn()
            .map_err(|_| "SDK私有组身份sentinel启动失败")?;
        let sentinel_identity = match identity(&sentinel) {
            Ok(identity) => identity,
            Err(error) => {
                let _ = sentinel.kill();
                let _ = sentinel.wait();
                return Err(error);
            }
        };
        let group = i32::try_from(sentinel.id()).map_err(|_| "SDK私有进程组标识无效")?;
        let mut command = launch.command();
        unsafe {
            command.pre_exec(move || {
                if libc::setpgid(0, group) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut node = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                let _ = sentinel.kill();
                let _ = sentinel.wait();
                return Err("SDK私有Node启动失败".into());
            }
        };
        let node_identity = match identity(&node) {
            Ok(identity) => identity,
            Err(error) => {
                let _ = node.kill();
                let _ = node.wait();
                let _ = sentinel.kill();
                let _ = sentinel.wait();
                return Err(error);
            }
        };
        Ok(Self {
            node,
            sentinel,
            node_identity,
            sentinel_identity,
            exit: None,
            sentinel_exited: false,
            stopped: false,
            empty: false,
            group,
        })
    }

    pub fn id(&self) -> u32 {
        self.node.id()
    }
    pub fn take_stdout(&mut self) -> Option<OutputReader> {
        self.node
            .stdout
            .take()
            .map(|reader| Box::new(reader) as OutputReader)
    }
    pub fn take_stderr(&mut self) -> Option<OutputReader> {
        self.node
            .stderr
            .take()
            .map(|reader| Box::new(reader) as OutputReader)
    }

    pub fn poll(&mut self) -> Result<Option<NodeExit>, String> {
        loop {
            let mut status = 0;
            let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
            if pid > 0 {
                if pid as u32 == self.node.id() {
                    self.exit = Some(NodeExit {
                        code: if libc::WIFEXITED(status) {
                            Some(libc::WEXITSTATUS(status))
                        } else {
                            None
                        },
                        signal: if libc::WIFSIGNALED(status) {
                            Some(libc::WTERMSIG(status))
                        } else {
                            None
                        },
                    });
                }
                if pid as u32 == self.sentinel.id() {
                    self.sentinel_exited = true;
                }
                continue;
            }
            if pid == 0 {
                break;
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            if error.raw_os_error() == Some(libc::ECHILD) {
                self.empty = true;
                break;
            }
            return Err("SDK私有监督waitpid失败".into());
        }
        if self.exit.is_some() && !exited(&self.node_identity)? {
            return Err("SDK私有Node缺少稳定身份退出资格".into());
        }
        if self.sentinel_exited && !exited(&self.sentinel_identity)? {
            return Err("SDK私有sentinel缺少稳定身份退出资格".into());
        }
        Ok(self.exit.clone())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if !self.stopped && !self.empty {
            if self.sentinel_exited {
                return Err("SDK私有进程组身份已丢失".into());
            }
            self.stopped = true;
            if unsafe { libc::kill(-self.group, libc::SIGKILL) } != 0 {
                return Err("SDK私有进程组停止失败".into());
            }
        }
        Ok(())
    }

    pub fn complete(&mut self) -> Result<bool, String> {
        if self.poll()?.is_none() {
            return Ok(false);
        }
        if self.empty {
            return Ok(true);
        }
        let members = children()?;
        if !self.sentinel_exited && members.iter().all(|pid| *pid as u32 == self.sentinel.id()) {
            self.sentinel.stdin.take();
        }
        self.poll()?;
        Ok(self.empty)
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        if !self.empty && !self.stopped && !self.sentinel_exited {
            let _ = self.stop();
        }
    }
}
