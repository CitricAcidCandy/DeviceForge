//! 独立std-only假ADB；每笔只记录自己的argv/PID，不创建daemon或派生进程。
use std::{
    env, fs,
    io::{self, Write},
    path::PathBuf,
    process, thread,
    time::{Duration, Instant},
};

fn main() {
    let root: PathBuf = env::current_exe().unwrap().parent().unwrap().to_owned();
    let mut index = 1;
    let call = loop {
        assert!(index <= 16, "假ADB调用必须有界");
        let directory = root.join(format!("call-{index:02}"));
        match fs::create_dir(&directory) {
            Ok(()) => break directory,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => index += 1,
            Err(error) => panic!("无法建立本次工具证据目录：{error}"),
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
    // 仅记录禁继承变量是否存在，不保存其值、部署环境或凭据。
    let keys = [
        "APK_ADB",
        "ADB_SERVER_SOCKET",
        "ANDROID_ADB_SERVER_PORT",
        "APK_API_TOKEN",
    ];
    let flags = keys.map(|key| u8::from(env::var_os(key).is_some()));
    fs::write(call.join("restricted-flags.bin"), flags).unwrap();
    fs::write(call.join("ready.tmp"), b"1").unwrap();
    fs::rename(call.join("ready.tmp"), call.join("ready")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match fs::read(root.join(format!("release-{index}"))) {
            Ok(bytes) => {
                fs::write(call.join("release-observed.bin"), &bytes).unwrap();
                assert_eq!(bytes, b"1");
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => panic!("释放门闩无法读取：{error}"),
        }
        assert!(Instant::now() < deadline, "失败兜底看门狗，不构成性能证据");
        thread::sleep(Duration::from_millis(2));
    }
    let stdout = fs::read(root.join(format!("stdout-{index}"))).unwrap();
    let stderr = fs::read(root.join(format!("stderr-{index}"))).unwrap();
    io::stdout().write_all(&stdout).unwrap();
    io::stdout().flush().unwrap();
    io::stderr().write_all(&stderr).unwrap();
    io::stderr().flush().unwrap();
    let code: i32 = fs::read_to_string(root.join(format!("code-{index}")))
        .unwrap()
        .parse()
        .unwrap();
    fs::write(call.join("normal-exit-code"), code.to_string()).unwrap();
    process::exit(code);
}
