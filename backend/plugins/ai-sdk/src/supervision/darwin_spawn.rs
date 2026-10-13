use super::{NodeExit, OutputReader};
use std::{
    collections::BTreeMap,
    ffi::{CString, OsString},
    fs::File,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    },
    path::Path,
};

struct Attribute(libc::posix_spawnattr_t);
impl Drop for Attribute {
    fn drop(&mut self) {
        unsafe {
            libc::posix_spawnattr_destroy(&mut self.0);
        }
    }
}

struct Actions(libc::posix_spawn_file_actions_t);
impl Drop for Actions {
    fn drop(&mut self) {
        unsafe {
            libc::posix_spawn_file_actions_destroy(&mut self.0);
        }
    }
}

fn pipe() -> Result<(File, File), String> {
    let mut descriptors = [0; 2];
    if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
        return Err("SDK原生管道创建失败".into());
    }
    let reader = unsafe { File::from_raw_fd(descriptors[0]) };
    let writer = unsafe { File::from_raw_fd(descriptors[1]) };
    for descriptor in descriptors {
        if unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return Err("SDK原生管道继承配置失败".into());
        }
    }
    Ok((reader, writer))
}

pub struct Child {
    pub pid: i32,
    pub input: Option<File>,
    pub stdout: Option<OutputReader>,
    pub stderr: Option<OutputReader>,
    pub exit: Option<NodeExit>,
}

impl Child {
    pub fn spawn(
        executable: &Path,
        arguments: &[OsString],
        environment: &BTreeMap<String, String>,
        group: i32,
        input_pipe: bool,
    ) -> Result<Self, String> {
        let executable =
            CString::new(executable.as_os_str().as_bytes()).map_err(|_| "SDK原生入口包含空字节")?;
        let mut argv = vec![executable.clone()];
        for argument in arguments {
            argv.push(
                CString::new(argument.as_os_str().as_bytes())
                    .map_err(|_| "SDK原生参数包含空字节")?,
            );
        }
        let mut argv_pointers: Vec<_> = argv
            .iter()
            .map(|argument| argument.as_ptr().cast_mut())
            .collect();
        argv_pointers.push(std::ptr::null_mut());
        let mut env = Vec::new();
        for (name, value) in environment {
            env.push(CString::new(format!("{name}={value}")).map_err(|_| "SDK原生环境包含空字节")?);
        }
        let mut env_pointers: Vec<_> = env.iter().map(|value| value.as_ptr().cast_mut()).collect();
        env_pointers.push(std::ptr::null_mut());
        let mut attr = std::ptr::null_mut();
        if unsafe { libc::posix_spawnattr_init(&mut attr) } != 0 {
            return Err("SDK原生启动属性创建失败".into());
        }
        let mut attr = Attribute(attr);
        let flags = (libc::POSIX_SPAWN_SETPGROUP
            | libc::POSIX_SPAWN_START_SUSPENDED
            | libc::POSIX_SPAWN_CLOEXEC_DEFAULT) as i16;
        if unsafe { libc::posix_spawnattr_setflags(&mut attr.0, flags) } != 0
            || unsafe { libc::posix_spawnattr_setpgroup(&mut attr.0, group) } != 0
        {
            return Err("SDK原生暂停出生和进程组配置失败".into());
        }
        let mut actions = std::ptr::null_mut();
        if unsafe { libc::posix_spawn_file_actions_init(&mut actions) } != 0 {
            return Err("SDK原生文件动作创建失败".into());
        }
        let mut actions = Actions(actions);
        let (stdout, stdout_writer) = pipe()?;
        let (stderr, stderr_writer) = pipe()?;
        let (input, input_writer) = if input_pipe {
            let (reader, writer) = pipe()?;
            (reader, Some(writer))
        } else {
            (
                File::open("/dev/null").map_err(|_| "SDK原生空输入不可用")?,
                None,
            )
        };
        for (descriptor, target) in [
            (input.as_raw_fd(), 0),
            (stdout_writer.as_raw_fd(), 1),
            (stderr_writer.as_raw_fd(), 2),
        ] {
            if unsafe { libc::posix_spawn_file_actions_adddup2(&mut actions.0, descriptor, target) }
                != 0
            {
                return Err("SDK原生管道绑定失败".into());
            }
        }
        let mut pid = 0;
        if unsafe {
            libc::posix_spawn(
                &mut pid,
                executable.as_ptr(),
                &actions.0,
                &attr.0,
                argv_pointers.as_ptr(),
                env_pointers.as_ptr(),
            )
        } != 0
            || pid <= 0
        {
            return Err("SDK原生暂停进程启动失败".into());
        }
        Ok(Self {
            pid,
            input: input_writer,
            stdout: Some(Box::new(stdout)),
            stderr: Some(Box::new(stderr)),
            exit: None,
        })
    }

    pub fn resume(&self) -> Result<(), String> {
        if unsafe { libc::kill(self.pid, libc::SIGCONT) } != 0 {
            return Err("SDK原生暂停进程恢复失败".into());
        }
        Ok(())
    }

    pub fn poll(&mut self) -> Result<Option<NodeExit>, String> {
        if self.exit.is_some() {
            return Ok(self.exit.clone());
        }
        loop {
            let mut status = 0;
            let result = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) };
            if result == 0 {
                return Ok(None);
            }
            if result == self.pid {
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
                return Ok(self.exit.clone());
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                return Err("SDK原生进程实际退出查询失败".into());
            }
        }
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        if self.exit.is_none() {
            unsafe {
                libc::kill(self.pid, libc::SIGKILL);
            }
            let _ = self.poll();
        }
    }
}
