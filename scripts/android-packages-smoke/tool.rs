//! 独立 std-only 清单工具：每私有任务目录/PID有独占观察文件，不模拟插件协议。
use std::{fs, io::{self, Write}, path::Path, thread, time::{Duration, Instant}};

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
    assert_ne!(snapshot as isize, -1, "必须真实取得进程列表");
    let mut entry: Entry = unsafe { std::mem::zeroed() }; entry.size = std::mem::size_of::<Entry>() as u32;
    let mut found = unsafe { Process32FirstW(snapshot, &mut entry) };
    let mut pid = None;
    while found != 0 {
        if entry.pid == std::process::id() { pid = Some(entry.parent); break; }
        found = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot); }
    let pid = pid.expect("必须找到本次工具的真实父进程");
    let process = unsafe { OpenProcess(0x1000, 0, pid) }; assert!(!process.is_null());
    let mut buffer = vec![0_u16; 32768]; let mut length = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) };
    unsafe { CloseHandle(process); } assert_ne!(ok, 0, "必须取得父插件真实执行路径");
    (pid, String::from_utf16(&buffer[..length as usize]).unwrap())
}

#[cfg(unix)]
fn parent() -> (u32, String) {
    unsafe extern "C" { fn getppid() -> i32; }
    let pid = u32::try_from(unsafe { getppid() }).unwrap();
    let executable = fs::read_link(format!("/proc/{pid}/exe")).expect("该平台须公开父进程执行路径");
    (pid, executable.to_str().unwrap().to_owned())
}

fn publish(directory: &Path, name: &str, bytes: &[u8]) {
    let temporary = directory.join(format!("{name}.tmp"));
    fs::write(&temporary, bytes).unwrap(); fs::rename(temporary, directory.join(name)).unwrap();
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    assert_eq!(args.len(), 3); assert_eq!(&args[..2], &["manifest", "print"]);
    let input = Path::new(&args[2]);
    let private = input.parent().unwrap();
    assert_eq!(std::env::current_dir().unwrap().canonicalize().unwrap(), private.canonicalize().unwrap());
    let root = std::env::current_exe().unwrap().parent().unwrap().canonicalize().unwrap();
    let observed = root.join("observations").join(format!("{}--{}", private.file_name().unwrap().to_str().unwrap(), std::process::id()));
    fs::create_dir(&observed).unwrap();
    let bytes = fs::read(input).unwrap(); assert!(bytes.len() <= 65536);
    fs::write(observed.join("input.bin"), &bytes).unwrap();
    let (plugin_pid, executable) = parent();
    let origin = Instant::now();
    let identity = format!("\"pid\":{},\"plugin_pid\":{},\"plugin_executable\":{},\"private_root\":{},\"input_path\":{}",
        std::process::id(), plugin_pid, escaped(&executable), escaped(private.to_str().unwrap()), escaped(input.to_str().unwrap()));
    let ready = format!("{{{identity},\"argv\":[{},{},{}],\"event\":\"ready\",\"monotonic_ns\":\"0\"}}\n",
        escaped(&args[0]), escaped(&args[1]), escaped(&args[2]));
    publish(&observed, "ready.json", ready.as_bytes());
    let guard = Instant::now() + Duration::from_secs(30);
    while !observed.join("release").exists() {
        if Instant::now() >= guard { eprintln!("独立工具门闩超时"); std::process::exit(90); }
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(fs::read(observed.join("release")).unwrap(), b"1");
    let xml = fs::read(root.join("manifest.xml")).unwrap();
    io::stdout().write_all(&xml).unwrap(); io::stdout().flush().unwrap();
    // 此事件只表示退出意图，调用方另核真实工具/父插件 PID 已不可见。
    let event = format!("{{{identity},\"event\":\"response_written_exit_intent\",\"code\":0,\"monotonic_ns\":\"{}\"}}\n", origin.elapsed().as_nanos());
    publish(&observed, "completed.json", event.as_bytes());
}
