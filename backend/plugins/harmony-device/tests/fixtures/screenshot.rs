use std::{
    fs,
    io::{self, BufWriter, Read, Write},
    path::{Path, PathBuf},
    process, thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(not(windows))]
use std::process::{Command, Stdio};

const IMAGE_LIMIT: u64 = 64 * 1024 * 1024;
const BODY_LIMIT: u64 = 89_478_617;
const TEXT_LIMIT: u64 = 1024 * 1024 + 1;
const WORKER_LIMIT: Duration = Duration::from_secs(6);
const WORKER_ARGUMENT: &str = "--deviceforge-screenshot-worker";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Probe,
    Capture,
    Size,
    Read,
    Clear,
}

impl Stage {
    fn name(self) -> &'static str {
        match self {
            Self::Probe => "probe",
            Self::Capture => "capture",
            Self::Size => "size",
            Self::Read => "read",
            Self::Clear => "clear",
        }
    }
}

struct Call {
    stage: Stage,
    token: String,
    remote: PathBuf,
}

fn valid_token(token: &str) -> bool {
    token.len() == 32
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn remote_path(root: &Path, token: &str) -> PathBuf {
    assert!(valid_token(token), "截图夹具所有权标识须为32位小写十六进制");
    root.join("screenshot-remote")
        .join(format!("deviceforge-screenshot-{token}"))
}

fn screenshot_call(root: &Path, arguments: &[String]) -> Option<Call> {
    if !root.join("screenshot-fixture").is_file() {
        return None;
    }
    assert_eq!(arguments.len(), 4, "截图只能使用四个固定HDC参数");
    assert_eq!(arguments[0], "-t");
    assert_eq!(arguments[2], "shell");
    let script = &arguments[3];
    let markers = [
        (Stage::Probe, "DF_PROBE_DONE:"),
        (Stage::Capture, "DF_CAPTURED:"),
        (Stage::Size, "DF_IMAGE_SIZE:"),
        (Stage::Read, "DF_READ_DONE:"),
        (Stage::Clear, "DF_CLEARED:"),
    ];
    let selected: Vec<_> = markers
        .into_iter()
        .filter(|(_, marker)| script.contains(marker))
        .collect();
    assert_eq!(selected.len(), 1, "每条固定脚本必须对应一个截图阶段");
    let (stage, marker) = selected[0];
    assert_eq!(script.matches(marker).count(), 1, "阶段终端回执不得重复");
    let offset = script.find(marker).unwrap() + marker.len();
    let token = script
        .get(offset..offset + 32)
        .expect("固定脚本缺少完整所有权标识");
    assert!(valid_token(token), "固定脚本包含非法所有权标识");
    let next = script.as_bytes().get(offset + 32).copied();
    assert!(
        matches!(next, Some(b':' | b'\'' | b'\\')),
        "所有权标识后只能是固定回执分隔符"
    );
    for (offset, _) in script.match_indices("deviceforge-screenshot-") {
        assert!(
            script[offset + "deviceforge-screenshot-".len()..].starts_with(token),
            "同一脚本不得混入其他调用的远端根"
        );
    }
    Some(Call {
        stage,
        token: token.to_owned(),
        remote: remote_path(root, token),
    })
}

fn planned_text(plan: &Path, name: &str) -> Option<String> {
    match fs::read_to_string(plan.join(name)) {
        Ok(value) => Some(value.trim().to_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => panic!("读取截图夹具计划失败：{error}"),
    }
}

fn source_image(root: &Path) -> PathBuf {
    let source = root.join("screenshot-source.jpeg");
    let metadata = fs::metadata(&source).unwrap();
    assert!(metadata.is_file());
    assert!(
        metadata.len() <= IMAGE_LIMIT + 1,
        "夹具图片只允许测试限额及超限一字节"
    );
    source
}

fn create_remote(root: &Path, call: &Call, image: bool) -> io::Result<()> {
    fs::create_dir_all(root.join("screenshot-remote"))?;
    fs::create_dir(&call.remote)?;
    fs::write(call.remote.join("owner"), format!("{}\n", call.token))?;
    if image {
        fs::copy(source_image(root), call.remote.join("screenshot.jpeg"))?;
    }
    Ok(())
}

fn clear_remote(call: &Call) -> io::Result<()> {
    let owner = fs::read(call.remote.join("owner"))?;
    if owner != format!("{}\n", call.token).as_bytes() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "远端所有权不匹配",
        ));
    }
    match fs::remove_file(call.remote.join("screenshot.jpeg")) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    fs::remove_file(call.remote.join("owner"))?;
    fs::remove_dir(&call.remote)
}

fn apply_action(root: &Path, directory: &Path, plan: &Path, call: &Call) {
    let action = planned_text(plan, "screenshot-action").unwrap_or_else(|| "none".to_owned());
    let result = match action.as_str() {
        "none" => Ok(()),
        "capture" => {
            assert_eq!(call.stage, Stage::Capture);
            create_remote(root, call, true)
        }
        "directory" => {
            assert_eq!(call.stage, Stage::Capture);
            create_remote(root, call, false)
        }
        "directory-without-owner" => {
            assert_eq!(call.stage, Stage::Capture);
            fs::create_dir_all(root.join("screenshot-remote")).unwrap();
            fs::create_dir(&call.remote)
        }
        "clear" => {
            assert_eq!(call.stage, Stage::Clear);
            clear_remote(call)
        }
        "clear-with-leftover" => {
            assert_eq!(call.stage, Stage::Clear);
            fs::write(call.remote.join("unexpected-file"), b"fixture-owned").unwrap();
            clear_remote(call)
        }
        _ => panic!("未知截图夹具副作用计划：{action}"),
    };
    let outcome = match result {
        Ok(()) => "complete".to_owned(),
        Err(error) => format!("failed:{:?}", error.kind()),
    };
    fs::write(directory.join("remote-action.outcome"), outcome).unwrap();
}

fn replace_bytes(input: &[u8], needle: &[u8], value: &[u8]) -> Vec<u8> {
    let mut output = Vec::new();
    let mut offset = 0;
    while offset < input.len() {
        if input[offset..].starts_with(needle) {
            output.extend_from_slice(value);
            offset += needle.len();
        } else {
            output.push(input[offset]);
            offset += 1;
        }
    }
    output
}

fn write_template(plan: &Path, name: &str, call: &Call, output: &mut impl Write) -> usize {
    let path = plan.join(name);
    assert!(fs::metadata(&path).unwrap().len() <= TEXT_LIMIT);
    let bytes = fs::read(path).unwrap();
    let bytes = replace_bytes(&bytes, b"{{TOKEN}}", call.token.as_bytes());
    let remote = format!("/data/local/tmp/deviceforge-screenshot-{}", call.token);
    let bytes = replace_bytes(&bytes, b"{{REMOTE}}", remote.as_bytes());
    let bytes = if bytes
        .windows(b"{{SIZE}}".len())
        .any(|part| part == b"{{SIZE}}")
    {
        let size = fs::metadata(call.remote.join("screenshot.jpeg"))
            .unwrap()
            .len();
        replace_bytes(&bytes, b"{{SIZE}}", size.to_string().as_bytes())
    } else {
        bytes
    };
    output.write_all(&bytes).unwrap();
    bytes.len()
}

fn write_base64(path: &Path, output: &mut impl Write) -> (u64, u64) {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    assert!(fs::metadata(path).unwrap().len() <= IMAGE_LIMIT + 1);
    let mut source = fs::File::open(path).unwrap();
    let mut input = [0; 65_538];
    let mut encoded = [0; 87_380];
    let mut pending = 0;
    let mut raw_count = 0_u64;
    let mut encoded_count = 0_u64;
    loop {
        let read = source.read(&mut input[pending..pending + 65_535]).unwrap();
        raw_count += read as u64;
        assert!(raw_count <= IMAGE_LIMIT + 1);
        let count = pending + read;
        let complete = count / 3 * 3;
        let mut written = 0;
        for chunk in input[..complete].chunks_exact(3) {
            encoded[written] = ALPHABET[usize::from(chunk[0] >> 2)];
            encoded[written + 1] = ALPHABET[usize::from((chunk[0] & 3) << 4 | chunk[1] >> 4)];
            encoded[written + 2] = ALPHABET[usize::from((chunk[1] & 15) << 2 | chunk[2] >> 6)];
            encoded[written + 3] = ALPHABET[usize::from(chunk[2] & 63)];
            written += 4;
        }
        output.write_all(&encoded[..written]).unwrap();
        encoded_count += written as u64;
        input.copy_within(complete..count, 0);
        pending = count - complete;
        if read == 0 {
            break;
        }
    }
    if pending != 0 {
        let mut tail = [b'='; 4];
        tail[0] = ALPHABET[usize::from(input[0] >> 2)];
        tail[1] = ALPHABET[usize::from((input[0] & 3) << 4)];
        if pending == 2 {
            tail[1] = ALPHABET[usize::from((input[0] & 3) << 4 | input[1] >> 4)];
            tail[2] = ALPHABET[usize::from((input[1] & 15) << 2)];
        }
        output.write_all(&tail).unwrap();
        encoded_count += 4;
    }
    (raw_count, encoded_count)
}

#[cfg(windows)]
mod inherited_stdio {
    use super::*;
    use std::{
        ffi::c_void,
        os::windows::{ffi::OsStrExt, io::AsRawHandle},
    };

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetStdHandle(identifier: u32) -> *mut c_void;
        fn GetHandleInformation(handle: *mut c_void, flags: *mut u32) -> i32;
        fn SetHandleInformation(handle: *mut c_void, mask: u32, flags: u32) -> i32;
        fn GetFileType(handle: *mut c_void) -> u32;
        fn GetLastError() -> u32;
        fn SetLastError(code: u32);
        fn InitializeProcThreadAttributeList(
            list: *mut c_void,
            count: u32,
            flags: u32,
            size: *mut usize,
        ) -> i32;
        fn UpdateProcThreadAttribute(
            list: *mut c_void,
            flags: u32,
            attribute: usize,
            value: *mut c_void,
            size: usize,
            previous: *mut c_void,
            returned: *mut usize,
        ) -> i32;
        fn DeleteProcThreadAttributeList(list: *mut c_void);
        fn CreateProcessW(
            application: *const u16,
            command: *mut u16,
            process_security: *mut c_void,
            thread_security: *mut c_void,
            inherit: i32,
            flags: u32,
            environment: *mut c_void,
            directory: *const u16,
            startup: *mut StartupInfo,
            information: *mut ProcessInformation,
        ) -> i32;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
        fn GetExitCodeProcess(handle: *mut c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    #[repr(C)]
    struct StartupInfo {
        size: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        position_x: u32,
        position_y: u32,
        width: u32,
        height: u32,
        character_width: u32,
        character_height: u32,
        fill_attribute: u32,
        flags: u32,
        show_window: u16,
        reserved_size: u16,
        reserved_bytes: *mut u8,
        input: *mut c_void,
        output: *mut c_void,
        error: *mut c_void,
    }

    #[repr(C)]
    struct ExtendedStartupInfo {
        startup: StartupInfo,
        attributes: *mut c_void,
    }

    #[repr(C)]
    struct ProcessInformation {
        process: *mut c_void,
        thread: *mut c_void,
        pid: u32,
        thread_id: u32,
    }

    struct Attributes(Vec<usize>);

    impl Drop for Attributes {
        fn drop(&mut self) {
            unsafe { DeleteProcThreadAttributeList(self.0.as_mut_ptr().cast()) };
        }
    }

    pub(super) struct Child {
        handle: *mut c_void,
        pid: u32,
        directory: PathBuf,
    }

    impl Child {
        pub(super) fn id(&self) -> u32 {
            self.pid
        }
        pub(super) fn try_wait(&mut self) -> io::Result<Option<u32>> {
            match unsafe { WaitForSingleObject(self.handle, 0) } {
                258 => Ok(None),
                0 => {
                    let mut code = 0;
                    if unsafe { GetExitCodeProcess(self.handle, &mut code) } == 0 {
                        Err(io::Error::last_os_error())
                    } else {
                        Ok(Some(code))
                    }
                }
                _ => Err(io::Error::last_os_error()),
            }
        }
    }

    impl Drop for Child {
        fn drop(&mut self) {
            if unsafe { CloseHandle(self.handle) } == 0 {
                let code = unsafe { GetLastError() };
                let _ = fs::write(
                    self.directory.join("late-worker-process-close.error.json"),
                    format!(r#"{{"operation":"CloseHandle-process","os_error":{code}}}"#),
                );
                assert!(thread::panicking(), "晚到进程等待句柄关闭失败：{code}");
            }
        }
    }

    struct Handle {
        name: &'static str,
        value: *mut c_void,
        flags: u32,
        file_type: u32,
    }

    fn failed(directory: &Path, operation: &str, name: &str, code: Option<u32>) -> ! {
        let code = code.map_or_else(|| "null".to_owned(), |value| value.to_string());
        fs::write(
            directory.join("late-worker-stdio.error.json"),
            format!(r#"{{"operation":"{operation}","standard":"{name}","os_error":{code}}}"#),
        )
        .unwrap();
        panic!("晚到进程标准句柄检查失败：{operation}/{name}/{code}");
    }

    fn snapshot(directory: &Path, filename: &str) -> Vec<Handle> {
        let mut handles = Vec::new();
        for (name, identifier) in [("stdin", -10_i32), ("stdout", -11), ("stderr", -12)] {
            let value = unsafe { GetStdHandle(identifier as u32) };
            if value.is_null() {
                failed(directory, "GetStdHandle-null", name, None);
            }
            if value as usize == usize::MAX {
                failed(
                    directory,
                    "GetStdHandle-invalid",
                    name,
                    Some(unsafe { GetLastError() }),
                );
            }
            let mut flags = 0;
            if unsafe { GetHandleInformation(value, &mut flags) } == 0 {
                failed(
                    directory,
                    "GetHandleInformation",
                    name,
                    Some(unsafe { GetLastError() }),
                );
            }
            unsafe { SetLastError(0) };
            let file_type = unsafe { GetFileType(value) };
            let code = unsafe { GetLastError() };
            if file_type == 0 && code != 0 {
                failed(directory, "GetFileType", name, Some(code));
            }
            handles.push(Handle {
                name,
                value,
                flags,
                file_type,
            });
        }
        let rows: Vec<_> = handles
            .iter()
            .map(|handle| {
                format!(
                    r#"{{"standard":"{}","handle":{},"flags":{},"file_type":{}}}"#,
                    handle.name, handle.value as usize, handle.flags, handle.file_type,
                )
            })
            .collect();
        fs::write(
            directory.join(filename),
            format!(
                r#"{{"pid":{},"handles":[{}]}}"#,
                process::id(),
                rows.join(",")
            ),
        )
        .unwrap();
        handles
    }

    pub(super) fn prepare(directory: &Path) {
        let before = snapshot(directory, "hdc-stdio-before.json");
        for handle in &before {
            if unsafe { SetHandleInformation(handle.value, 1, 0) } == 0 {
                failed(
                    directory,
                    "SetHandleInformation",
                    handle.name,
                    Some(unsafe { GetLastError() }),
                );
            }
        }
        let after = snapshot(directory, "hdc-stdio-after.json");
        for (before, after) in before.iter().zip(&after) {
            assert_eq!(before.value, after.value);
            assert_eq!(before.file_type, after.file_type);
            assert_eq!(before.flags & !1, after.flags);
        }
    }

    pub(super) fn observe(directory: &Path) {
        let _ = snapshot(directory, "late-worker-stdio.json");
    }

    pub(super) fn spawn(
        root: &Path,
        directory: &Path,
        mode: &str,
        token: &str,
        call_name: &str,
    ) -> Child {
        let null = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("NUL")
            .unwrap();
        let mut null_handle = null.as_raw_handle();
        if unsafe { SetHandleInformation(null_handle, 1, 1) } == 0 {
            failed(
                directory,
                "SetHandleInformation-NUL",
                "worker",
                Some(unsafe { GetLastError() }),
            );
        }
        let mut size = 0;
        let result =
            unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
        let code = unsafe { GetLastError() };
        if result != 0 || code != 122 || size == 0 {
            failed(
                directory,
                "InitializeProcThreadAttributeList-size",
                "worker",
                Some(code),
            );
        }
        let mut storage = vec![0_usize; size.div_ceil(std::mem::size_of::<usize>())];
        if unsafe {
            InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 1, 0, &mut size)
        } == 0
        {
            failed(
                directory,
                "InitializeProcThreadAttributeList",
                "worker",
                Some(unsafe { GetLastError() }),
            );
        }
        let mut attributes = Attributes(storage);
        if unsafe {
            UpdateProcThreadAttribute(
                attributes.0.as_mut_ptr().cast(),
                0,
                0x0002_0002,
                (&mut null_handle as *mut *mut c_void).cast(),
                std::mem::size_of::<*mut c_void>(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } == 0
        {
            failed(
                directory,
                "UpdateProcThreadAttribute-HANDLE_LIST",
                "worker",
                Some(unsafe { GetLastError() }),
            );
        }
        let executable = std::env::current_exe().unwrap();
        let application: Vec<u16> = executable
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let mut command = vec![u16::from(b'"')];
        command.extend(executable.as_os_str().encode_wide());
        command.push(u16::from(b'"'));
        for argument in [WORKER_ARGUMENT, mode, token, call_name] {
            assert!(
                argument
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            );
            command.push(u16::from(b' '));
            command.extend(argument.encode_utf16());
        }
        command.push(0);
        let current_directory: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut environment = Vec::new();
        if let Some(value) = std::env::var_os("SystemRoot") {
            environment.extend("SystemRoot=".encode_utf16());
            environment.extend(value.encode_wide());
            environment.push(0);
        } else {
            environment.push(0);
        }
        environment.push(0);
        let mut startup: ExtendedStartupInfo = unsafe { std::mem::zeroed() };
        startup.startup.size = u32::try_from(std::mem::size_of::<ExtendedStartupInfo>()).unwrap();
        startup.startup.flags = 0x0000_0100;
        startup.startup.input = null_handle;
        startup.startup.output = null_handle;
        startup.startup.error = null_handle;
        startup.attributes = attributes.0.as_mut_ptr().cast();
        let mut information: ProcessInformation = unsafe { std::mem::zeroed() };
        if unsafe {
            CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                0x0808_0400,
                environment.as_mut_ptr().cast(),
                current_directory.as_ptr(),
                &mut startup.startup,
                &mut information,
            )
        } == 0
        {
            failed(
                directory,
                "CreateProcessW-HANDLE_LIST",
                "worker",
                Some(unsafe { GetLastError() }),
            );
        }
        let child = Child {
            handle: information.process,
            pid: information.pid,
            directory: directory.to_owned(),
        };
        if unsafe { CloseHandle(information.thread) } == 0 {
            failed(
                directory,
                "CloseHandle-thread",
                "worker",
                Some(unsafe { GetLastError() }),
            );
        }
        fs::write(directory.join("late-worker-inheritance.json"), format!(
            r#"{{"pid":{},"handle_list":[{}],"inherit_handles":true,"creation_flags":134743040}}"#,
            child.pid, null_handle as usize)).unwrap();
        child
    }
}

mod late {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    fn call_name(directory: &Path) -> String {
        let name = directory.file_name().unwrap().to_str().unwrap();
        assert_eq!(name.len(), 7);
        assert!(name.starts_with("call-"));
        let ordinal: usize = name[5..].parse().unwrap();
        assert!((1..=8).contains(&ordinal));
        name.to_owned()
    }

    pub(super) fn spawn(root: &Path, directory: &Path, plan: &Path, call: &Call) {
        let Some(mode) = planned_text(plan, "screenshot-worker") else {
            return;
        };
        match mode.as_str() {
            "writer" | "directory" => assert_eq!(call.stage, Stage::Capture),
            "reader" => assert_eq!(call.stage, Stage::Read),
            _ => panic!("未知晚到进程角色：{mode}"),
        }
        assert!(!directory.join("late-worker.pid").exists());
        #[cfg(windows)]
        inherited_stdio::prepare(directory);
        #[cfg(windows)]
        let mut child =
            inherited_stdio::spawn(root, directory, &mode, &call.token, &call_name(directory));
        #[cfg(not(windows))]
        let mut child = {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([WORKER_ARGUMENT, &mode, &call.token, &call_name(directory)])
                .current_dir(root)
                .env_clear()
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            if let Some(value) = std::env::var_os("SystemRoot") {
                command.env("SystemRoot", value);
            }
            command.spawn().unwrap()
        };
        fs::write(directory.join("late-worker.pid"), child.id().to_string()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !directory.join("late-worker.ready").exists() {
            assert!(
                child.try_wait().unwrap().is_none(),
                "晚到进程未进入ready即退出"
            );
            assert!(Instant::now() < deadline, "晚到进程ready超时");
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(fs::read(directory.join("late-worker.ready")).unwrap(), b"1");
    }

    fn run(root: &Path, directory: &Path, call: &Call, mode: &str) -> io::Result<i32> {
        let mut reader = if mode == "reader" {
            Some(fs::File::open(call.remote.join("screenshot.jpeg"))?)
        } else {
            None
        };
        fs::write(directory.join("late-worker.mode"), mode)?;
        fs::write(directory.join("late-worker.ready.tmp"), b"1")?;
        fs::rename(
            directory.join("late-worker.ready.tmp"),
            directory.join("late-worker.ready"),
        )?;
        loop {
            match fs::read(directory.join("late-worker.trigger")) {
                Ok(bytes) if bytes == b"1" => break,
                Ok(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "晚到进程触发值无效",
                    ));
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            thread::sleep(Duration::from_millis(2));
        }
        if let Some(source) = reader.as_mut() {
            let mut prefix = [0; 64];
            let count = source.read(&mut prefix)?;
            fs::write(directory.join("late-reader.bytes"), &prefix[..count])?;
        } else {
            create_remote(root, call, mode == "writer")?;
            fs::write(directory.join("late-writer.created"), b"1")?;
        }
        drop(reader);
        Ok(0)
    }

    pub(super) fn entry() -> Option<i32> {
        let arguments: Vec<_> = std::env::args().skip(1).collect();
        if arguments.first().map(String::as_str) != Some(WORKER_ARGUMENT) {
            return None;
        }
        assert_eq!(arguments.len(), 4);
        let mode = &arguments[1];
        assert!(matches!(mode.as_str(), "writer" | "directory" | "reader"));
        let token = &arguments[2];
        assert!(valid_token(token));
        let executable = std::env::current_exe().unwrap();
        let root = executable.parent().unwrap();
        let directory = root.join(&arguments[3]);
        assert_eq!(call_name(&directory), arguments[3]);
        assert!(directory.is_dir());
        let start = Instant::now();
        let deadline = start + WORKER_LIMIT;
        let finished = Arc::new(AtomicBool::new(false));
        let watched = Arc::clone(&finished);
        let evidence = directory.clone();
        thread::spawn(move || {
            thread::sleep(deadline.saturating_duration_since(Instant::now()));
            if !watched.load(Ordering::Acquire) {
                let _ = fs::write(evidence.join("late-worker.watchdog-expired"), b"1");
                let _ = fs::write(evidence.join("late-worker.exit-intent"), b"124");
                process::exit(124);
            }
        });
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        fs::write(directory.join("late-worker.started-ns"), stamp.to_string()).unwrap();
        #[cfg(windows)]
        inherited_stdio::observe(&directory);
        let call = Call {
            stage: if mode == "reader" {
                Stage::Read
            } else {
                Stage::Capture
            },
            token: token.to_owned(),
            remote: remote_path(root, token),
        };
        let code = match run(root, &directory, &call, mode) {
            Ok(code) => code,
            Err(error) => {
                fs::write(
                    directory.join("late-worker.error"),
                    format!("{:?}", error.kind()),
                )
                .unwrap();
                1
            }
        };
        fs::write(directory.join("late-worker.exit-intent"), code.to_string()).unwrap();
        fs::write(
            directory.join("late-worker.elapsed-ns"),
            start.elapsed().as_nanos().to_string(),
        )
        .unwrap();
        finished.store(true, Ordering::Release);
        Some(code)
    }
}

pub fn worker_entry() -> Option<i32> {
    late::entry()
}

pub fn before_ready(root: &Path, directory: &Path, plan: &Path, arguments: &[String]) {
    if let Some(call) = screenshot_call(root, arguments) {
        fs::write(directory.join("screenshot.stage"), call.stage.name()).unwrap();
        fs::write(directory.join("screenshot.token"), &call.token).unwrap();
        late::spawn(root, directory, plan, &call);
    }
}

pub fn write_response(
    root: &Path,
    directory: &Path,
    plan: &Path,
    arguments: &[String],
) -> Option<i32> {
    let call = screenshot_call(root, arguments)?;
    apply_action(root, directory, plan, &call);
    let stdout = io::stdout();
    let mut output = BufWriter::new(stdout.lock());
    let mut prefix_bytes = 0;
    if plan.join("screenshot-base64").exists() {
        assert_eq!(call.stage, Stage::Read);
        assert!(!plan.join("screenshot-body.bin").exists());
        let (raw, encoded) = write_base64(&call.remote.join("screenshot.jpeg"), &mut output);
        fs::write(
            directory.join("base64-counts.json"),
            format!(r#"{{"raw":{raw},"encoded":{encoded}}}"#),
        )
        .unwrap();
        prefix_bytes = encoded;
    } else if plan.join("screenshot-body.bin").exists() {
        assert_eq!(call.stage, Stage::Read);
        let body = fs::File::open(plan.join("screenshot-body.bin")).unwrap();
        assert!(body.metadata().unwrap().len() <= BODY_LIMIT);
        prefix_bytes = body.metadata().unwrap().len();
        io::copy(&mut body.take(BODY_LIMIT), &mut output).unwrap();
    }
    let tail_bytes = write_template(plan, "stdout", &call, &mut output) as u64;
    output.flush().unwrap();
    let stderr_bytes = write_template(plan, "stderr", &call, &mut io::stderr().lock());
    io::stderr().flush().unwrap();
    fs::write(
        directory.join("stream-counts.json"),
        format!(
            r#"{{"stdout":{},"body":{prefix_bytes},"tail":{tail_bytes},"stderr":{stderr_bytes}}}"#,
            prefix_bytes + tail_bytes,
        ),
    )
    .unwrap();
    Some(
        fs::read_to_string(plan.join("code"))
            .unwrap()
            .trim()
            .parse()
            .unwrap(),
    )
}
