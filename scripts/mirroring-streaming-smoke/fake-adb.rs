//! 独立标准库 ADB/socket 夹具，保存真实 argv 和持久远端所有权模拟。
mod socket_server;
use std::{env, fs, io::{self, Write}, path::{Path, PathBuf}, thread, time::{Duration, Instant}};

fn atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension("tmp"); fs::write(&temporary, bytes)?; fs::rename(temporary, path)
}

fn field(script: &str, prefix: &str) -> String {
    script.split_whitespace().find_map(|part| part.strip_prefix(prefix))
        .unwrap_or_else(|| panic!("缺少固定参数 {prefix}")).trim_end_matches(';').to_owned()
}

fn call_directory(root: &Path) -> PathBuf {
    for ordinal in 1..=200 {
        let directory = root.join(format!("call-{ordinal:03}"));
        match fs::create_dir(&directory) {
            Ok(()) => return directory,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
            Err(error) => panic!("观测目录失败：{error}"),
        }
    }
    panic!("夹具调用数超限")
}

fn write_argv(path: &Path, args: &[String]) {
    let mut bytes = (args.len() as u32).to_le_bytes().to_vec();
    for argument in args { bytes.extend_from_slice(&(argument.len() as u32).to_le_bytes()); bytes.extend_from_slice(argument.as_bytes()); }
    fs::write(path, bytes).unwrap();
}

fn safe_device(value: &str) -> bool {
    !value.is_empty() && value.len() <= 80 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn run() -> io::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    assert!(args.len() >= 3 && args[0] == "-s" && safe_device(&args[1]), "夹具只接受独占设备 argv");
    let root = env::current_exe()?.parent().unwrap().canonicalize()?;
    let plan = root.join("plans").join(&args[1]); assert!(plan.is_dir(), "设备计划未授权");
    let call = call_directory(&root);
    write_argv(&call.join("argv.bin"), &args); fs::write(call.join("pid"), std::process::id().to_string())?;
    fs::write(call.join("device"), &args[1])?;
    let category = match args[2].as_str() {
        "push" => "push",
        "forward" if args.get(3).is_some_and(|value| value == "--remove") => "remove-forward",
        "forward" if args.get(3).is_some_and(|value| value == "--list") => "list-forward",
        "forward" => "forward",
        "shell" if args.get(3).is_some_and(|value| value == "mkdir") => "mkdir",
        "shell" if args.get(3).is_some_and(|value| value.contains("com.genymobile.scrcpy.Server")) => "server",
        "shell" if args.len() == 4 && args[3].contains("DFML_CLEAN") => "cleanup",
        _ => panic!("夹具拒绝未声明命令"),
    };
    fs::write(call.join("category"), category)?;
    if category == "server" { fs::write(plan.join("server-attempted"), "1")?; }
    atomic(&call.join("ready"), b"1")?;
    if plan.join("gate-short").exists() {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !call.join("release").exists() {
            assert!(Instant::now() < deadline, "短命令门闩超时"); thread::sleep(Duration::from_millis(5));
        }
    }
    match category {
        "mkdir" => {
            assert!(args.len() == 5 && args[4].starts_with("/data/local/tmp/deviceforge_"));
            fs::write(plan.join("remote-dir"), &args[4])?;
        },
        "push" => {
            assert!(args.len() == 5 && Path::new(&args[3]).is_absolute());
            let remote = fs::read_to_string(plan.join("remote-dir"))?;
            assert_eq!(args[4], format!("{remote}/server.jar"));
            fs::write(plan.join("pushed.bin"), fs::read(&args[3])?)?;
        },
        "forward" => {
            assert!(args.len() == 6 && args[3] == "--no-rebind" && args[4] == "tcp:0");
            let scid = args[5].strip_prefix("localabstract:scrcpy_").expect("必须绑定独占 socket");
            assert!(scid.len() == 8 && scid.bytes().all(|byte| byte.is_ascii_hexdigit()));
            let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            let port = listener.local_addr()?.port(); drop(listener);
            fs::write(plan.join("port"), port.to_string())?; fs::write(plan.join("scid"), scid)?;
            fs::write(plan.join("forward-owned"), port.to_string())?;
            println!("{port}"); io::stdout().flush()?;
        },
        "server" => {
            assert_eq!(args.len(), 4);
            let script = &args[3]; let remote = fs::read_to_string(plan.join("remote-dir"))?;
            assert!(script.starts_with(&format!("echo $$ > {remote}/pid && CLASSPATH={remote}/server.jar exec app_process / ")));
            assert!(script.contains(" com.genymobile.scrcpy.Server 3.3.1 "));
            assert_eq!(field(script, "scid="), fs::read_to_string(plan.join("scid"))?);
            for fixed in ["tunnel_forward=true", "video=true", "video_codec=h264", "audio_codec=raw",
                "send_device_meta=false", "send_dummy_byte=false", "send_codec_meta=true", "send_frame_meta=true",
                "clipboard_autosync=false", "cleanup=false", "power_on=false"] { assert!(script.split_whitespace().any(|part| part == fixed)); }
            let owner = field(script, "--nice-name="); assert!(owner.starts_with("deviceforge_"));
            fs::write(plan.join("remote-pid"), "7001")?; fs::write(plan.join("remote-owner"), owner)?;
            socket_server::run(&plan, &call, field(script, "audio=") == "true", field(script, "control=") == "true")?;
        },
        "cleanup" => {
            let script = &args[3]; let remote = fs::read_to_string(plan.join("remote-dir"))?;
            let owner = format!("deviceforge_{}", remote.strip_prefix("/data/local/tmp/deviceforge_").unwrap());
            let attempted = plan.join("server-attempted").exists();
            let prefix = if attempted { format!("i=0; while [ ! -f {remote}/pid ]; do i=$((i+1)); [ $i -le 10 ] || exit 77; sleep 0.05; done; ") } else { String::new() };
            let expected = format!("{prefix}if [ -f {remote}/pid ]; then p=$(cat {remote}/pid); case $p in ''|*[!0-9]*) exit 71;; esac; if [ -e /proc/$p ]; then n=$(tr '\\000' '\\n' < /proc/$p/cmdline | head -n 1); [ \"$n\" = {owner} ] || exit 72; kill -TERM $p || exit 73; i=0; while kill -0 $p 2>/dev/null; do i=$((i+1)); [ $i -le 20 ] || exit 74; sleep 0.05; done; fi; fi; rm -rf {remote} || exit 75; [ ! -e {remote} ] || exit 76; echo DFML_CLEAN");
            assert_eq!(script, &expected, "清理须严格符合独占资源合同");
            if let Ok(actual) = fs::read_to_string(plan.join("remote-owner")) { assert_eq!(actual, owner); }
            if (attempted && !plan.join("remote-pid").exists()) || plan.join("cleanup-denied").exists() { return Err(io::Error::other("模拟远端身份或清理确认失败")); }
            for name in ["remote-pid", "remote-owner", "remote-dir", "server-attempted"] {
                match fs::remove_file(plan.join(name)) { Ok(()) => {}, Err(error) if error.kind() == io::ErrorKind::NotFound => {}, Err(error) => return Err(error) }
            }
            atomic(&plan.join("remote-cleaned"), b"1")?; println!("DFML_CLEAN"); io::stdout().flush()?;
        },
        "remove-forward" => {
            assert_eq!(args.len(), 5); let port = fs::read_to_string(plan.join("forward-owned"))?;
            assert_eq!(args[4], format!("tcp:{port}")); fs::remove_file(plan.join("forward-owned"))?;
            atomic(&plan.join("forward-removed"), b"1")?;
        },
        "list-forward" => {
            assert_eq!(args.len(), 4);
            if let Ok(port) = fs::read_to_string(plan.join("forward-owned")) {
                let scid = fs::read_to_string(plan.join("scid"))?;
                println!("{} tcp:{} localabstract:scrcpy_{}", args[1], port, scid); io::stdout().flush()?;
            }
        },
        _ => unreachable!(),
    }
    atomic(&call.join("completed"), b"1")?; Ok(())
}

fn main() {
    if let Err(error) = run() { eprintln!("投屏夹具失败：{error}"); std::process::exit(9); }
}
