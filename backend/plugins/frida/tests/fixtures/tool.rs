//! 独立标准库假工具：保留实际argv、输入与PID，不派生进程或接触设备。
use std::{env, fs, io::{self, Read, Write}, path::PathBuf, process, thread, time::{Duration, Instant}};

fn main() {
    let root: PathBuf = env::current_exe().unwrap().parent().unwrap().to_owned();
    let mut index = 1;
    let call = loop {
        assert!(index <= 32, "假工具调用须有界");
        let candidate = root.join(format!("call-{index:02}"));
        match fs::create_dir(&candidate) {
            Ok(()) => break candidate,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => index += 1,
            Err(error) => panic!("无法创建工具证据：{error}"),
        }
    };
    let args: Vec<String> = env::args().skip(1).collect();
    let mut encoded = Vec::new();
    encoded.extend_from_slice(&u32::try_from(args.len()).unwrap().to_le_bytes());
    for arg in &args {
        encoded.extend_from_slice(&u32::try_from(arg.len()).unwrap().to_le_bytes());
        encoded.extend_from_slice(arg.as_bytes());
    }
    fs::write(call.join("argv.bin"), encoded).unwrap();
    fs::write(call.join("pid"), process::id().to_string()).unwrap();
    let mut input = Vec::new(); io::stdin().read_to_end(&mut input).unwrap();
    fs::write(call.join("stdin.bin"), input).unwrap();
    if args.len() == 5 && args[0] == "-s" && args[2] == "push" {
        fs::copy(&args[3], call.join("source.bin")).unwrap();
    }
    if args.first().map(String::as_str) == Some("-D") && args.iter().any(|arg| arg == "-l") {
        let position = args.iter().position(|arg| arg == "-l").unwrap();
        fs::copy(&args[position + 1], call.join("script.js")).unwrap();
        fs::write(call.join("cwd"), env::current_dir().unwrap().to_str().unwrap()).unwrap();
        for key in ["TEMP", "TMP", "TMPDIR"] {
            fs::write(call.join(key), env::var(key).unwrap()).unwrap();
        }
    }
    // 只记录是否继承测试标记，绝不采集任意环境值或凭据。
    let flags = ["APK_API_TOKEN", "ADB_SERVER_SOCKET", "JAVA_TOOL_OPTIONS"]
        .map(|key| u8::from(env::var_os(key).is_some()));
    fs::write(call.join("restricted.bin"), flags).unwrap();
    fs::write(call.join("ready.tmp"), b"1").unwrap();
    fs::rename(call.join("ready.tmp"), call.join("ready")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !root.join(format!("release-{index}")).is_file() {
        assert!(Instant::now() < deadline, "失败兜底看门狗，不构成业务超时证据");
        thread::sleep(Duration::from_millis(2));
    }
    let output = fs::read(root.join(format!("stdout-{index}"))).unwrap();
    io::stdout().write_all(&output).unwrap(); io::stdout().flush().unwrap();
    let errors = fs::read(root.join(format!("stderr-{index}"))).unwrap();
    io::stderr().write_all(&errors).unwrap(); io::stderr().flush().unwrap();
    let code: i32 = fs::read_to_string(root.join(format!("code-{index}"))).unwrap().parse().unwrap();
    fs::write(call.join("normal-exit-code"), code.to_string()).unwrap();
    process::exit(code);
}
