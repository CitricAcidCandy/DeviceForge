//! 独立std-only假HDC，只记录本次直接进程与实际参数，不启动daemon。
use std::{env, fs, io::{self, Write}, process, thread, time::{Duration, Instant}};

fn main() {
    let root = env::current_exe().unwrap().parent().unwrap().to_owned();
    let call = root.join("call-01");
    fs::create_dir(&call).unwrap();
    let args: Vec<String> = env::args().skip(1).collect();
    let mut encoded = Vec::new();
    encoded.extend_from_slice(&u32::try_from(args.len()).unwrap().to_le_bytes());
    for arg in &args {
        encoded.extend_from_slice(&u32::try_from(arg.len()).unwrap().to_le_bytes());
        encoded.extend_from_slice(arg.as_bytes());
    }
    fs::write(call.join("argv.bin"), encoded).unwrap();
    fs::write(call.join("pid"), process::id().to_string()).unwrap();
    if args.len() == 4 && args[0] == "-t" && args[2] == "install" {
        fs::copy(&args[3], call.join("install-input.bin")).unwrap();
    }
    let keys = ["APK_HDC", "HDC_SERVER_SOCKET", "HDC_SERVER_PORT", "APK_API_TOKEN"];
    let flags = keys.map(|key| u8::from(env::var_os(key).is_some()));
    fs::write(call.join("restricted-flags.bin"), flags).unwrap();
    fs::write(call.join("ready.tmp"), b"1").unwrap();
    fs::rename(call.join("ready.tmp"), call.join("ready")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match fs::read(root.join("release")) {
            Ok(bytes) => {
                fs::write(call.join("release-observed.bin"), &bytes).unwrap();
                assert_eq!(bytes, b"1");
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => panic!("释放门闩读取失败：{error}"),
        }
        assert!(Instant::now() < deadline, "失败兜底看门狗");
        thread::sleep(Duration::from_millis(2));
    }
    if root.join("echo-install-path").exists() {
        writeln!(io::stdout(), "Installed {}\nmsg:install bundle successfully.", args[3]).unwrap();
    } else {
        let mut stdout = fs::File::open(root.join("stdout")).unwrap();
        io::copy(&mut stdout, &mut io::stdout()).unwrap();
    }
    io::stdout().flush().unwrap();
    let mut stderr = fs::File::open(root.join("stderr")).unwrap();
    io::copy(&mut stderr, &mut io::stderr()).unwrap();
    io::stderr().flush().unwrap();
    let code: i32 = fs::read_to_string(root.join("code")).unwrap().parse().unwrap();
    fs::write(call.join("normal-exit-code"), code.to_string()).unwrap();
    process::exit(code);
}
