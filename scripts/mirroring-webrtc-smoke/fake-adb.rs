//! 与当前设备进程身份合同一致的独立 ADB 夹具。
#[path = "socket_server.rs"]
mod socket_server;
use std::{env, fs, io::{self, Write}, path::{Path, PathBuf}, thread, time::{Duration, Instant}};

fn field(script: &str, prefix: &str) -> String {
    script.split_whitespace().find_map(|item| item.strip_prefix(prefix))
        .unwrap_or_else(|| panic!("缺少固定参数 {prefix}")).trim_end_matches(';').to_owned()
}

fn call_directory(root: &Path) -> PathBuf {
    for index in 1..=200 {
        let path = root.join(format!("call-{index:03}"));
        match fs::create_dir(&path) {
            Ok(()) => return path,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
            Err(error) => panic!("调用目录失败：{error}"),
        }
    }
    panic!("夹具调用超限")
}

fn identity(scid: &str) -> String {
    format!("a=$(tr '\\000' '\\n' < /proc/$p/cmdline); n=$(printf '%s\\n' \"$a\" | head -n 1); [ \"$n\" = app_process ] && printf '%s\\n' \"$a\" | grep -Fxq com.genymobile.scrcpy.Server && printf '%s\\n' \"$a\" | grep -Fxq 3.3.1 && printf '%s\\n' \"$a\" | grep -Fxq scid={scid} && printf '%s\\n' \"$a\" | grep -Fxq tunnel_forward=true")
}

fn main_inner() -> io::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    assert!(args.len() >= 3 && args[0] == "-s" && args[1].bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'));
    let root = env::current_exe()?.parent().unwrap().canonicalize()?;
    let plan = root.join("plans").join(&args[1]);
    assert!(plan.is_dir());
    let call = call_directory(&root);
    fs::write(call.join("pid"), std::process::id().to_string())?;
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
            assert!(args[4].starts_with("/data/local/tmp/deviceforge_"));
            fs::write(plan.join("remote-dir"), &args[4])?;
        },
        "push" => {
            let remote = fs::read_to_string(plan.join("remote-dir"))?;
            assert_eq!(args[4], format!("{remote}/server.jar"));
            fs::write(plan.join("pushed.bin"), fs::read(&args[3])?)?;
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
            fs::write(plan.join("port"), port.to_string())?;
            fs::write(plan.join("scid"), scid)?;
            fs::write(plan.join("forward-owned"), port.to_string())?;
            println!("{port}"); io::stdout().flush()?;
        },
        "server" => {
            assert_eq!(args.len(), 4);
            let script = &args[3];
            let remote = fs::read_to_string(plan.join("remote-dir"))?;
            let scid = fs::read_to_string(plan.join("scid"))?;
            assert!(script.starts_with(&format!("echo $$ > {remote}/pid && CLASSPATH={remote}/server.jar exec app_process / ")));
            assert!(script.contains(" com.genymobile.scrcpy.Server 3.3.1 "));
            assert_eq!(field(script, "scid="), scid);
            for fixed in ["tunnel_forward=true", "send_device_meta=false", "send_dummy_byte=false", "cleanup=false"] {
                assert!(script.split_whitespace().any(|item| item == fixed));
            }
            if field(script, "audio=") == "true" {
                let codec = field(script, "audio_codec=");
                assert_eq!(codec, if args[1] == "webrtc-check" { "opus" } else { "raw" });
            } else {
                assert!(!script.contains("audio_codec="));
            }
            fs::write(plan.join("remote-pid"), "7001")?;
            fs::write(plan.join("remote-owner"), &scid)?;
            socket_server::run(&plan, &call, field(script, "audio=") == "true", field(script, "control=") == "true")?;
        },
        "ready" => {
            let remote = fs::read_to_string(plan.join("remote-dir"))?;
            let scid = fs::read_to_string(plan.join("scid"))?;
            let expected = format!("i=0; while [ $i -lt 100 ]; do if [ -f {remote}/pid ]; then p=$(cat {remote}/pid); case $p in ''|*[!0-9]*) exit 71;; esac; if [ -e /proc/$p ]; then if {} && grep -q ' @scrcpy_{scid}$' /proc/net/unix; then echo DFML_READY; exit 0; fi; fi; fi; i=$((i+1)); sleep 0.05; done; exit 78", identity(&scid));
            assert_eq!(args[3], expected);
            let deadline = Instant::now() + Duration::from_secs(10);
            while !plan.join("epoch-1").join("listening").exists() {
                assert!(Instant::now() < deadline, "直播套接字未就绪");
                thread::sleep(Duration::from_millis(5));
            }
            println!("DFML_READY");
        },
        "cleanup" => {
            let remote = fs::read_to_string(plan.join("remote-dir"))?;
            let scid = fs::read_to_string(plan.join("scid"))?;
            let expected = format!("i=0; while [ ! -f {remote}/pid ]; do i=$((i+1)); [ $i -le 10 ] || exit 77; sleep 0.05; done; if [ -f {remote}/pid ]; then p=$(cat {remote}/pid); case $p in ''|*[!0-9]*) exit 71;; esac; if [ -e /proc/$p ]; then {} || exit 72; kill -TERM $p || exit 73; i=0; while kill -0 $p 2>/dev/null; do i=$((i+1)); [ $i -le 20 ] || exit 74; sleep 0.05; done; fi; fi; rm -rf {remote} || exit 75; [ ! -e {remote} ] || exit 76; echo DFML_CLEAN", identity(&scid));
            assert_eq!(args[3], expected);
            for name in ["remote-pid", "remote-owner", "remote-dir"] { fs::remove_file(plan.join(name))?; }
            fs::write(plan.join("remote-cleaned"), "1")?;
            println!("DFML_CLEAN");
        },
        "list-forward" => {
            if let Ok(port) = fs::read_to_string(plan.join("forward-owned")) {
                println!("{} tcp:{} localabstract:scrcpy_{}", args[1], port, fs::read_to_string(plan.join("scid"))?);
            }
        },
        "remove-forward" => {
            let port = fs::read_to_string(plan.join("forward-owned"))?;
            assert_eq!(args[4], format!("tcp:{port}"));
            fs::remove_file(plan.join("forward-owned"))?;
            fs::write(plan.join("forward-removed"), "1")?;
        },
        _ => unreachable!(),
    }
    Ok(())
}

fn main() {
    if let Err(error) = main_inner() { eprintln!("WebRTC假ADB失败：{error}"); std::process::exit(9); }
}
