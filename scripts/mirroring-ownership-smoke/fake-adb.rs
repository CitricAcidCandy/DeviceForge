#[path = "socket_server.rs"]
mod socket_server;

use std::{env, fs, io::{self, Write}, path::{Path, PathBuf}, thread, time::{Duration, Instant}};

fn field(script: &str, prefix: &str) -> String {
    script.split_whitespace().find_map(|item| item.strip_prefix(prefix))
        .unwrap_or_else(|| panic!("缺少参数 {prefix}")).trim_end_matches(';').to_owned()
}

fn remote(script: &str) -> String {
    const PREFIX: &str = "/data/local/tmp/deviceforge_";
    let start = script.find(PREFIX).expect("缺少远端目录");
    let end = start + PREFIX.len() + 32;
    let path = script.get(start..end).expect("远端目录长度不足");
    assert!(path[PREFIX.len()..].bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert!(script.get(end..).is_some_and(|tail| tail.is_empty() || tail.starts_with('/') || tail.starts_with(char::is_whitespace)));
    path.to_owned()
}

fn session(plan: &Path, path: &str) -> PathBuf {
    plan.join("sessions").join(path.strip_prefix("/data/local/tmp/deviceforge_").unwrap())
}

fn call_directory(root: &Path) -> io::Result<PathBuf> {
    for index in 1..=1000 {
        let path = root.join(format!("call-{index:04}"));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::other("夹具调用超限"))
}

fn identity(scid: &str, version: &str) -> String {
    format!("a=$(tr '\\000' '\\n' < /proc/$p/cmdline); n=$(printf '%s\\n' \"$a\" | head -n 1); [ \"$n\" = app_process ] && printf '%s\\n' \"$a\" | grep -Fxq com.genymobile.scrcpy.Server && printf '%s\\n' \"$a\" | grep -Fxq {version} && printf '%s\\n' \"$a\" | grep -Fxq scid={scid} && printf '%s\\n' \"$a\" | grep -Fxq tunnel_forward=true")
}

fn main_inner() -> io::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    assert!(args.len() >= 3 && args[0] == "-s" && args[1].bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'));
    let root = env::current_exe()?.parent().unwrap().canonicalize()?;
    let plan = root.join("plans").join(&args[1]);
    assert!(plan.is_dir());
    let version = fs::read_to_string(plan.join("server-version"))?;
    assert!(matches!(version.as_str(), "3.3.1" | "3.3.4"), "夹具服务器版本不在白名单");
    let call = call_directory(&root)?;
    fs::write(call.join("pid"), std::process::id().to_string())?;
    fs::write(call.join("argv"), args.join("\n"))?;
    let category = match args[2].as_str() {
        "push" => "push",
        "forward" if args.get(3).is_some_and(|item| item == "--remove") => "remove-forward",
        "forward" if args.get(3).is_some_and(|item| item == "--list") => "list-forward",
        "forward" => "forward",
        "shell" if args.get(3).is_some_and(|item| item == "mkdir") => "mkdir",
        "shell" if args.get(3).is_some_and(|item| item.contains("DFML_READY")) => "ready",
        "shell" if args.get(3).is_some_and(|item| item.contains("DFML_CLEAN")) => "cleanup",
        "shell" if args.get(3).is_some_and(|item| item.contains("com.genymobile.scrcpy.Server")) => "server",
        _ => panic!("拒绝未声明ADB命令"),
    };
    fs::write(call.join("category"), category)?;
    match category {
        "mkdir" => {
            assert_eq!(args.len(), 5);
            let path = session(&plan, &args[4]);
            fs::create_dir_all(&path)?;
            fs::write(path.join("remote-dir"), &args[4])?;
        },
        "push" => {
            let path = session(&plan, &remote(&args[4]));
            assert!(path.join("remote-dir").exists());
            fs::write(path.join("pushed.bin"), fs::read(&args[3])?)?;
        },
        "forward" => {
            assert_eq!(args.len(), 6);
            assert_eq!(args[3], "--no-rebind");
            assert_eq!(args[4], "tcp:0");
            let scid = args[5].strip_prefix("localabstract:scrcpy_").unwrap();
            assert!(scid.len() == 8 && scid.bytes().all(|byte| byte.is_ascii_hexdigit()));
            let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            let port = listener.local_addr()?.port();
            drop(listener);
            let forward = plan.join("forwards").join(scid);
            fs::create_dir_all(&forward)?;
            fs::write(forward.join("port"), port.to_string())?;
            fs::write(forward.join("owned"), "1")?;
            println!("{port}"); io::stdout().flush()?;
        },
        "server" => {
            assert_eq!(args.len(), 4);
            let script = &args[3];
            let remote = remote(script);
            let path = session(&plan, &remote);
            let scid = field(script, "scid=");
            assert!(script.starts_with(&format!("echo $$ > {remote}/pid && CLASSPATH={remote}/server.jar exec app_process / com.genymobile.scrcpy.Server {version} ")));
            for fixed in ["tunnel_forward=true", "send_device_meta=false", "send_dummy_byte=false", "cleanup=false", "audio=false"] {
                assert!(script.split_whitespace().any(|item| item == fixed));
            }
            let video = field(script, "video=") == "true";
            assert_eq!(field(script, "control="), "true");
            let autosync = field(script, "clipboard_autosync=") == "true";
            assert!(!video || !autosync);
            let port = fs::read_to_string(plan.join("forwards").join(&scid).join("port"))?;
            fs::write(path.join("port"), port)?;
            fs::write(path.join("scid"), scid)?;
            fs::write(path.join("remote-pid"), std::process::id().to_string())?;
            fs::write(path.join("mode"), if video { "video" } else { "control" })?;
            fs::write(path.join("clipboard-autosync"), autosync.to_string())?;
            socket_server::run(&plan, &path, video, autosync)?;
        },
        "ready" => {
            let path = session(&plan, &remote(&args[3]));
            let deadline = Instant::now() + Duration::from_secs(10);
            while !path.join("listening").exists() {
                assert!(Instant::now() < deadline, "直播套接字未就绪");
                thread::sleep(Duration::from_millis(5));
            }
            let scid = fs::read_to_string(path.join("scid"))?;
            assert!(args[3].contains(&identity(&scid, &version)));
            println!("DFML_READY");
        },
        "cleanup" => {
            let path = session(&plan, &remote(&args[3]));
            if let Ok(scid) = fs::read_to_string(path.join("scid")) {
                assert!(args[3].contains(&identity(&scid, &version)));
            }
            for name in ["remote-pid", "remote-dir"] {
                match fs::remove_file(path.join(name)) {
                    Ok(()) => {},
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {},
                    Err(error) => return Err(error),
                }
            }
            fs::write(path.join("cleaned"), "1")?;
            println!("DFML_CLEAN");
        },
        "list-forward" => {
            let forwards = plan.join("forwards");
            if forwards.exists() {
                for entry in fs::read_dir(forwards)? {
                    let entry = entry?;
                    if entry.path().join("owned").exists() {
                        println!("{} tcp:{} localabstract:scrcpy_{}", args[1], fs::read_to_string(entry.path().join("port"))?, entry.file_name().to_string_lossy());
                    }
                }
            }
        },
        "remove-forward" => {
            let port = args[4].strip_prefix("tcp:").unwrap();
            let mut removed = false;
            for entry in fs::read_dir(plan.join("forwards"))? {
                let entry = entry?;
                if fs::read_to_string(entry.path().join("port"))? == port {
                    fs::remove_file(entry.path().join("owned"))?;
                    fs::write(entry.path().join("removed"), "1")?;
                    removed = true;
                }
            }
            assert!(removed);
        },
        _ => unreachable!(),
    }
    fs::write(call.join("exited"), "1")?;
    Ok(())
}

fn main() {
    if let Err(error) = main_inner() { eprintln!("控制权假ADB失败：{error}"); std::process::exit(9); }
}
