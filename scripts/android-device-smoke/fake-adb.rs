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

// 独立五笔夹具按真实父插件PID绑定同一次样本；不读取生产解析或采样状态。
fn performance(root: &Path, args: &[String], plugin_pid: u32) -> Option<(Vec<u8>, String)> {
    if args.len() < 6 || args[0] != "-s" || args[2] != "shell" || args[3] != "-T"
        || !matches!(args[4].as_str(), "pidof" | "cat" | "dumpsys") { return None; }
    let data_path = root.join(format!("sample-{plugin_pid}.txt"));
    let stat_path = root.join(format!("sample-{plugin_pid}-stat.txt"));
    if args[4] == "pidof" {
        assert_eq!(args.len(), 7); assert_eq!(args[5], "-s");
        let tick = u64::try_from(timestamp() / 1_000_000).unwrap();
        fs::write(&data_path, format!("{}\n{tick}", args[6])).unwrap(); fs::write(&stat_path, "0").unwrap();
    }
    let data = fs::read_to_string(data_path).unwrap();
    let mut fields = data.lines(); let package = fields.next().unwrap();
    let tick: u64 = fields.next().unwrap().parse().unwrap();
    let (step, output) = match args[4].as_str() {
        "pidof" => (1, b"2468\n".to_vec()),
        "cat" if args[5] == "/proc/2468/stat" => {
            assert_eq!(args.len(), 6);
            let count: u32 = fs::read_to_string(&stat_path).unwrap().parse().unwrap();
            assert!(count < 2); fs::write(&stat_path, (count + 1).to_string()).unwrap();
            let mut stat = vec!["0".to_owned(); 20]; stat[0] = "S".to_owned();
            stat[11] = (tick * 6).to_string(); stat[12] = (tick * 4).to_string(); stat[19] = "900".to_owned();
            (if count == 0 { 2 } else { 4 }, format!("2468 (独立(name)采样) {}\n", stat.join(" ")).into_bytes())
        }
        "dumpsys" => {
            assert_eq!(args.len(), 8); assert_eq!(&args[5..], ["meminfo", "-s", "2468"]);
            (3, b"** MEMINFO in pid 2468 [org.smoke.performance] **\nTOTAL PSS: 2048\nTOTAL RSS: 4096\n".to_vec())
        }
        "cat" if args[5] == "/proc/stat" => {
            assert_eq!(args.len(), 6);
            (5, format!("cpu {} 0 0 0 0 0 0 0 99 1\ncpu0 1 0 0 0\ncpu1 1 0 0 0\n", tick * 100).into_bytes())
        }
        _ => panic!("出现未冻结的性能argv"),
    };
    Some((output, format!(",\"tool_kind\":\"performance\",\"performance_step\":{step},\"sample_tick\":{tick},\"sample_package\":{}", escaped(package))))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = std::env::current_exe().unwrap().parent().unwrap().canonicalize().unwrap();
    let mode = fs::read_to_string(root.join("mode")).unwrap();
    if !root.join("pixel.png").exists() {
        let mut pixel = vec![0_u8; 45];
        pixel[..16].copy_from_slice(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR");
        pixel[19] = 1; pixel[23] = 1;
        fs::write(root.join("pixel.png"), pixel).unwrap();
    }
    let observed = root.join("observations").join(format!("{}--{}", timestamp(), std::process::id()));
    fs::create_dir(&observed).unwrap();
    let (plugin_pid, executable) = parent();
    let mut identity = format!("\"pid\":{},\"plugin_pid\":{},\"plugin_executable\":{},\"argv\":[{}]",
        std::process::id(), plugin_pid, escaped(&executable), args.iter().map(|value| escaped(value)).collect::<Vec<_>>().join(","));
    // 同一独立二进制只增加明确Java入口，不调用生产插件或真实ADB。
    let java = args.first().map(String::as_str) == Some("-Xmx256m");
    let performance = performance(&root, &args, plugin_pid);
    if let Some((_, fields)) = &performance { identity.push_str(fields); }
    if java {
        assert_eq!(args.len(), 7);
        assert_eq!(args[1], "-jar"); assert_eq!(args[3], "install-apks");
        assert!(Path::new(&args[2]).is_absolute() && fs::metadata(&args[2]).unwrap().is_file());
        let input = args[4].strip_prefix("--apks=").expect("必须传私有APKS");
        assert_eq!(Path::new(input).file_name().unwrap(), "input.apks");
        assert!(args[5].strip_prefix("--device-id=").is_some_and(|value| !value.is_empty()));
        let adb = args[6].strip_prefix("--adb=").expect("必须传固定ADB");
        assert!(Path::new(adb).is_absolute() && fs::metadata(adb).unwrap().is_file());
        fs::copy(input, observed.join("install-input.bin")).unwrap();
        let cwd = std::env::current_dir().unwrap();
        identity.push_str(&format!(",\"tool_kind\":\"java\",\"cwd\":{},\"temp\":{},\"tmp\":{},\"tmpdir\":{}",
            escaped(cwd.to_str().unwrap()), escaped(&std::env::var("TEMP").unwrap()),
            escaped(&std::env::var("TMP").unwrap()), escaped(&std::env::var("TMPDIR").unwrap())));
    } else if args.len() == 4 && args[0] == "-s" && args[2] == "install" {
        fs::copy(&args[3], observed.join("install-input.bin")).unwrap();
    }
    publish(&observed, "ready.json", format!("{{{identity},\"event\":\"ready\",\"mode\":{},\"unix_ns\":\"{}\"}}\n", escaped(&mode), timestamp()).as_bytes());
    if mode == "hold" {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !observed.join("release").exists() {
            if Instant::now() >= deadline { eprintln!("假ADB门闩超时"); std::process::exit(90); }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(fs::read(observed.join("release")).unwrap(), b"1");
    }
    let output: Vec<u8> = if let Some((bytes, _)) = performance { bytes } else if java {
        match mode.as_str() {
            "apks-empty" => Vec::new(),
            "apks-lossy" => vec![0xff, 0xfe],
            _ => b"installation complete\n".to_vec(),
        }
    } else if args == ["devices", "-l"] {
        if mode == "duplicate" { b"List of devices attached\n".iter().copied().chain("模拟:甲\tdevice\n模拟:甲\tdevice\n".bytes()).collect() }
        else { "List of devices attached\n模拟:甲\tdevice model:模拟甲\nemulator-5556\tdevice model:模拟乙\noffline-0001\toffline\nerror:serial\tvendor_state model:未知型号\n".as_bytes().to_vec() }
    } else if args.len() == 2 && args[0] == "connect" { b"connected to 127.0.0.1:5555\n".to_vec() }
    else if args.len() == 2 && args[0] == "disconnect" { b"disconnected 127.0.0.1:5555\n".to_vec() }
    else if args.len() >= 4 && args[0] == "-s" {
        match args[2].as_str() {
            "install" if args.len() == 4 => format!("Installed {}\nSuccess\n", args[3]).into_bytes(),
            "exec-out" if args.len() == 5 && args[3] == "screencap" && args[4] == "-p" => fs::read(root.join("pixel.png")).unwrap(),
            "uninstall" => b"Success\n".to_vec(),
            "shell" if args.get(3).map(String::as_str) == Some("pm") => b"package:com.failed.example\npackage:org.smoke.app\n".to_vec(),
            "shell" if args.get(3).map(String::as_str) == Some("monkey") => b"Events injected: 1\n".to_vec(),
            "shell" if args.get(3).map(String::as_str) == Some("am") => Vec::new(),
            "shell" if args.get(3).map(String::as_str) == Some("-T") => Vec::new(),
            _ => panic!("出现未声明的假ADB命令"),
        }
    } else { panic!("出现未声明的假ADB命令"); };
    let output = if mode == "diagnostic" { b"error: synthetic diagnostic\n".to_vec() } else { output };
    io::stdout().write_all(&output).unwrap(); io::stdout().flush().unwrap();
    publish(&observed, "completed.json", format!("{{{identity},\"event\":\"response_written_exit_intent\",\"code\":0,\"unix_ns\":\"{}\"}}\n", timestamp()).as_bytes());
}
