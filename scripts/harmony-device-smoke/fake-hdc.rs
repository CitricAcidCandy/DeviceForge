use std::{fs, io::{self, Write}, path::Path, thread, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

fn escaped(value: &str) -> String {
    let mut output = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""), '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"), '\r' => output.push_str("\\r"), '\t' => output.push_str("\\t"),
            value if value.is_control() => output.push_str(&format!("\\u{:04x}", value as u32)),
            value => output.push(value),
        }
    }
    output.push('"'); output
}

#[cfg(windows)]
fn parent() -> (u32, String) {
    use std::ffi::c_void;
    #[repr(C)]
    struct Entry { size: u32, usage: u32, pid: u32, heap: usize, module: u32,
        threads: u32, parent: u32, priority: i32, flags: u32, executable: [u16; 260] }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
        fn Process32FirstW(snapshot: *mut c_void, entry: *mut Entry) -> i32;
        fn Process32NextW(snapshot: *mut c_void, entry: *mut Entry) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn QueryFullProcessImageNameW(process: *mut c_void, flags: u32, path: *mut u16, size: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    let snapshot = unsafe { CreateToolhelp32Snapshot(2, 0) };
    assert_ne!(snapshot as isize, -1);
    let mut entry: Entry = unsafe { std::mem::zeroed() }; entry.size = std::mem::size_of::<Entry>() as u32;
    let mut found = unsafe { Process32FirstW(snapshot, &mut entry) };
    let mut pid = None;
    while found != 0 {
        if entry.pid == std::process::id() { pid = Some(entry.parent); break; }
        found = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot); }
    let pid = pid.expect("必须取得工具父进程");
    let process = unsafe { OpenProcess(0x1000, 0, pid) }; assert!(!process.is_null());
    let mut buffer = vec![0_u16; 32768]; let mut length = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) };
    unsafe { CloseHandle(process); } assert_ne!(ok, 0);
    (pid, String::from_utf16(&buffer[..length as usize]).unwrap())
}

#[cfg(unix)]
fn parent() -> (u32, String) {
    unsafe extern "C" { fn getppid() -> i32; }
    let pid = u32::try_from(unsafe { getppid() }).unwrap();
    let executable = fs::read_link(format!("/proc/{pid}/exe")).unwrap();
    (pid, executable.to_str().unwrap().to_owned())
}

fn publish(directory: &Path, name: &str, bytes: &[u8]) {
    let temporary = directory.join(format!("{name}.tmp"));
    fs::write(&temporary, bytes).unwrap(); fs::rename(temporary, directory.join(name)).unwrap();
}

fn timestamp() -> u128 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() }

// 每次真实工具调用独占证据目录；门闩只影响本次直接客户端。
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = std::env::current_exe().unwrap().parent().unwrap().canonicalize().unwrap();
    let mode = fs::read_to_string(root.join("mode")).unwrap();
    let observed = root.join("observations").join(format!("{}--{}", timestamp(), std::process::id()));
    fs::create_dir(&observed).unwrap();
    let (plugin_pid, executable) = parent();
    let identity = format!("\"pid\":{},\"plugin_pid\":{},\"plugin_executable\":{},\"argv\":[{}]",
        std::process::id(), plugin_pid, escaped(&executable), args.iter().map(|value| escaped(value)).collect::<Vec<_>>().join(","));
    if args.len() == 4 && args[0] == "-t" && args[2] == "install" {
        fs::copy(&args[3], observed.join("install-input.bin")).unwrap();
    }
    publish(&observed, "ready.json", format!("{{{identity},\"event\":\"ready\",\"mode\":{},\"unix_ns\":\"{}\"}}\n", escaped(&mode), timestamp()).as_bytes());
    if mode == "hold" {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !observed.join("release").exists() {
            if Instant::now() >= deadline { eprintln!("假HDC门闩超时"); std::process::exit(90); }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(fs::read(observed.join("release")).unwrap(), b"1");
    }
    let output: Vec<u8> = if args == ["list", "targets"] {
        if mode == "duplicate" { b"HDC001\nHDC001\n".to_vec() } else { b"HDC001\nHDC002\n".to_vec() }
    } else if args.len() == 4 && args[0] == "-t" && args[2] == "install" {
        format!("Installed {}\nmsg:install bundle successfully.\n", args[3]).into_bytes()
    } else if args.len() == 4 && args[0] == "-t" && args[2] == "uninstall" {
        b"msg:uninstall bundle successfully.\n".to_vec()
    } else if args.len() == 6 && args[0] == "-t" && args[2..] == ["shell", "bm", "dump", "-a"] {
        b"com.alpha.app\ncom.beta.app\n".to_vec()
    } else { panic!("出现未声明的假HDC命令"); };
    io::stdout().write_all(&output).unwrap(); io::stdout().flush().unwrap();
    publish(&observed, "completed.json", format!("{{{identity},\"event\":\"response_written_exit_intent\",\"code\":0,\"unix_ns\":\"{}\"}}\n", timestamp()).as_bytes());
}
