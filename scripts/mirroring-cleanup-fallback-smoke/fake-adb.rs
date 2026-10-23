//! 清理有限重试的独立 ADB 进程夹具，只操作自身目录内的模拟资源。
#[path = "../mirroring-webrtc-smoke/socket_server.rs"]
mod socket_server;

use std::{
    env, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

fn timestamp() -> String {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis().to_string()
}

fn allocate(root: &Path, prefix: &str) -> io::Result<(PathBuf, usize)> {
    for index in 1..=200 {
        let path = root.join(format!("{prefix}-{index:03}"));
        match fs::create_dir(&path) {
            Ok(()) => return Ok((path, index)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::other("夹具调用次数超限"))
}

fn read(plan: &Path, name: &str) -> io::Result<String> {
    fs::read_to_string(plan.join(name))
}

fn field(script: &str, prefix: &str) -> String {
    script.split_whitespace().find_map(|item| item.strip_prefix(prefix))
        .unwrap_or_else(|| panic!("缺少固定参数：{prefix}")).trim_end_matches(';').to_owned()
}

fn identity(scid: &str, version: &str) -> String {
    format!("a=$(tr '\\000' '\\n' < /proc/$p/cmdline); n=$(printf '%s\\n' \"$a\" | head -n 1); [ \"$n\" = app_process ] && printf '%s\\n' \"$a\" | grep -Fxq com.genymobile.scrcpy.Server && printf '%s\\n' \"$a\" | grep -Fxq {version} && printf '%s\\n' \"$a\" | grep -Fxq scid={scid} && printf '%s\\n' \"$a\" | grep -Fxq tunnel_forward=true")
}

fn classify(args: &[String]) -> &'static str {
    assert!(args.len() >= 3 && args[0] == "-s", "拒绝未指定设备及全局命令");
    assert!(args[1].bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'));
    let next = args.get(3).map(String::as_str).unwrap_or("");
    match args[2].as_str() {
        "push" => "push",
        "forward" if next == "--list" => "list-forward",
        "forward" if next == "--remove" => "remove-forward",
        "forward" if next == "--no-rebind" => "forward",
        "shell" if next == "mkdir" => "mkdir",
        "shell" if next.contains("DFML_READY") => "ready",
        "shell" if next.contains("DFML_CLEAN") => "cleanup",
        "shell" if next.contains("com.genymobile.scrcpy.Server") => "server",
        _ => panic!("拒绝未声明的 ADB 命令"),
    }
}

fn wait_gate(root: &Path, call: &Path) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(8);
    while !call.join("release").exists() {
        if root.join("stop-fixture").exists() || Instant::now() >= deadline {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "原始 OS 句柄门闩未释放"));
        }
        thread::sleep(Duration::from_millis(2));
    }
    Ok(())
}

fn delay_injection(root: &Path, millis: u64) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_millis(millis);
    while Instant::now() < deadline {
        if root.join("stop-fixture").exists() {
            return Err(io::Error::other("本轮夹具收尾"));
        }
        thread::sleep(Duration::from_millis(2));
    }
    Ok(())
}

fn execute(root: &Path, call: &Path, args: &[String], category: &str) -> io::Result<i32> {
    let device = &args[1];
    let plan = root.join("plans").join(device);
    assert!(device.starts_with("cleanup-") || device.starts_with("retry-after-"));
    assert!(plan.is_dir(), "拒绝未声明的设备");
    let version = read(&plan, "server-version")?;
    assert!(matches!(version.as_str(), "3.3.1" | "3.3.4"));
    let mode = read(&plan, "mode")?;
    assert!(matches!(mode.as_str(), "success" | "list-once" | "remove-reply-lost" |
        "cleanup-once" | "list-always" | "foreign-forward" | "shared-budget"));
    match category {
        "mkdir" => {
            assert_eq!(args.len(), 5);
            let nonce = args[4].strip_prefix("/data/local/tmp/deviceforge_").unwrap();
            assert_eq!(nonce.len(), 32);
            assert!(nonce.bytes().all(|byte| byte.is_ascii_hexdigit()));
            fs::write(plan.join("remote-dir"), &args[4])?;
            fs::write(plan.join("expected-dir"), &args[4])?;
        }
        "push" => {
            assert_eq!(args.len(), 5);
            assert_eq!(args[4], format!("{}/server.jar", read(&plan, "remote-dir")?));
            let bytes = fs::read(&args[3])?;
            assert_eq!(bytes, "独立scrcpy-server协议占位输入".as_bytes());
            fs::write(plan.join("pushed.bin"), bytes)?;
        }
        "forward" => {
            assert_eq!(args.len(), 6);
            assert_eq!(args[3], "--no-rebind");
            assert_eq!(args[4], "tcp:0");
            let scid = args[5].strip_prefix("localabstract:scrcpy_").unwrap();
            assert!(scid.len() == 8 && scid.bytes().all(|byte| byte.is_ascii_hexdigit()));
            let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            let port = listener.local_addr()?.port().to_string();
            drop(listener);
            for (name, value) in [("port", port.as_str()), ("scid", scid),
                ("forward-owned", port.as_str()), ("forward-device", device.as_str()),
                ("forward-scid", scid)] {
                fs::write(plan.join(name), value)?;
            }
            println!("{port}");
        }
        "server" => {
            assert_eq!(args.len(), 4);
            let remote = read(&plan, "expected-dir")?;
            let scid = read(&plan, "scid")?;
            let expected = format!("echo $$ > {remote}/pid && CLASSPATH={remote}/server.jar exec app_process / com.genymobile.scrcpy.Server {version} scid={scid} tunnel_forward=true video=true video_bit_rate=4000000 audio=false max_size=1024 max_fps=30 control=false clipboard_autosync=false send_device_meta=false send_dummy_byte=false cleanup=false");
            assert_eq!(args[3], expected, "启动合同变更须显式审核夹具，不能宽松放行");
            assert_eq!(field(&args[3], "scid="), scid);
            fs::write(plan.join("remote-pid"), "7001")?;
            fs::write(plan.join("remote-owner"), scid)?;
            socket_server::run(&plan, call, false, false)?;
        }
        "ready" => {
            assert_eq!(args.len(), 4);
            let remote = read(&plan, "expected-dir")?;
            let scid = read(&plan, "scid")?;
            let expected = format!("i=0; while [ $i -lt 100 ]; do if [ -f {remote}/pid ]; then p=$(cat {remote}/pid); case $p in ''|*[!0-9]*) exit 71;; esac; if [ -e /proc/$p ]; then if {} && grep -q ' @scrcpy_{scid}$' /proc/net/unix; then echo DFML_READY; exit 0; fi; fi; fi; i=$((i+1)); sleep 0.05; done; exit 78", identity(&scid, &version));
            assert_eq!(args[3], expected, "就绪合同变更须显式审核夹具");
            let deadline = Instant::now() + Duration::from_secs(6);
            while !plan.join("epoch-1/listening").exists() {
                assert!(Instant::now() < deadline, "本轮媒体套接字未就绪");
                thread::sleep(Duration::from_millis(5));
            }
            println!("DFML_READY");
        }
        "cleanup" => {
            assert_eq!(args.len(), 4);
            let remote = read(&plan, "expected-dir")?;
            let scid = read(&plan, "scid")?;
            let expected = format!("i=0; while [ ! -f {remote}/pid ]; do i=$((i+1)); [ $i -le 10 ] || exit 77; sleep 0.05; done; if [ -f {remote}/pid ]; then p=$(cat {remote}/pid); case $p in ''|*[!0-9]*) exit 71;; esac; if [ -e /proc/$p ]; then {} || exit 72; kill -TERM $p || exit 73; i=0; while kill -0 $p 2>/dev/null; do i=$((i+1)); [ $i -le 20 ] || exit 74; sleep 0.05; done; fi; fi; rm -rf {remote} || exit 75; [ ! -e {remote} ] || exit 76; echo DFML_CLEAN", identity(&scid, &version));
            assert_eq!(args[3], expected, "清理合同变更须显式审核夹具，禁止省略版本及所有权");
            let (_, attempt) = allocate(&plan, "cleanup-attempt")?;
            if mode == "cleanup-once" && attempt == 1 {
                fs::write(call.join("injection"), "清理执行前的瞬态失败")?;
                return Ok(73);
            }
            if plan.join("remote-dir").exists() {
                assert_eq!(read(&plan, "remote-owner")?, scid);
                for name in ["remote-dir", "remote-pid", "remote-owner"] {
                    fs::remove_file(plan.join(name))?;
                }
                fs::write(plan.join("remote-cleaned"), "1")?;
                println!("DFML_CLEAN");
            } else {
                // 当前精确脚本在启动后缺 PID 时应失败，不能伪造幂等成功。
                fs::write(call.join("injection"), "现有脚本缺 PID，拒绝伪成功")?;
                return Ok(77);
            }
        }
        "list-forward" => {
            assert_eq!(args.len(), 4);
            let (_, attempt) = allocate(&plan, "list-attempt")?;
            if mode == "shared-budget" {
                fs::write(call.join("delay-ms"), "2400")?;
                delay_injection(root, 2400)?;
            }
            if (matches!(mode.as_str(), "list-once" | "shared-budget") && attempt == 1)
                || mode == "list-always" {
                fs::write(call.join("injection"), "转发查询的非零退出")?;
                return Ok(1);
            }
            if mode == "foreign-forward" && attempt == 1 {
                fs::write(plan.join("forward-device"), "foreign-device")?;
                fs::write(plan.join("forward-scid"), "ffffffff")?;
                let row = format!("foreign-device tcp:{} localabstract:scrcpy_ffffffff\n", read(&plan, "port")?);
                fs::write(plan.join("foreign-original"), row)?;
            }
            if plan.join("forward-owned").exists() {
                print!("{} tcp:{} localabstract:scrcpy_{}\n", read(&plan, "forward-device")?,
                    read(&plan, "forward-owned")?, read(&plan, "forward-scid")?);
            }
        }
        "remove-forward" => {
            assert_eq!(args.len(), 5);
            assert_eq!(args[4], format!("tcp:{}", read(&plan, "forward-owned")?));
            assert_eq!(read(&plan, "forward-device")?, *device, "禁止删除外来设备映射");
            assert_eq!(read(&plan, "forward-scid")?, read(&plan, "scid")?, "禁止删除外来会话映射");
            let (_, attempt) = allocate(&plan, "remove-attempt")?;
            for name in ["forward-owned", "forward-device", "forward-scid"] {
                fs::remove_file(plan.join(name))?;
            }
            fs::write(plan.join("forward-removed"), "1")?;
            if mode == "remove-reply-lost" && attempt == 1 {
                fs::write(call.join("injection"), "删除已执行，回执非零")?;
                return Ok(1);
            }
        }
        _ => panic!("拒绝全局及未声明命令"),
    }
    Ok(0)
}

fn main_inner() -> io::Result<i32> {
    let root = env::current_exe()?.parent().unwrap().canonicalize()?;
    assert!(root.join("fixture-owner").is_file(), "只允许从本轮独占夹具目录运行");
    let args: Vec<String> = env::args().skip(1).collect();
    let (call, _) = allocate(&root, "call")?;
    fs::write(call.join("pid"), std::process::id().to_string())?;
    fs::write(call.join("started-unix-ms"), timestamp())?;
    let mut argv = Vec::new();
    argv.extend_from_slice(&(args.len() as u32).to_le_bytes());
    for value in &args {
        argv.extend_from_slice(&(value.len() as u32).to_le_bytes());
        argv.extend_from_slice(value.as_bytes());
    }
    fs::write(call.join("argv.bin"), argv)?;
    let category = std::panic::catch_unwind(|| classify(&args)).unwrap_or("rejected");
    fs::write(call.join("category"), category)?;
    fs::write(call.join("ready"), "1")?;
    let owned_root = root.clone();
    let owned_call = call.clone();
    // 仅结束此 fake ADB 自身，失败收尾不按历史 PID 杀进程，也不调用系统 ADB。
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            if owned_root.join("stop-fixture").exists() || Instant::now() >= deadline {
                let _ = fs::write(owned_call.join("fixture-stop"), timestamp());
                std::process::exit(96);
            }
            thread::sleep(Duration::from_millis(10));
        }
    });
    let result = std::panic::catch_unwind(|| -> io::Result<i32> {
        wait_gate(&root, &call)?;
        fs::write(call.join("action-started-unix-ms"), timestamp())?;
        execute(&root, &call, &args, category)
    });
    let code = match result {
        Ok(Ok(code)) => code,
        Ok(Err(error)) => {
            fs::write(call.join("failure"), error.to_string())?;
            91
        }
        Err(_) => {
            fs::write(call.join("failure"), "夹具拒绝不匹配的调用合同")?;
            92
        }
    };
    io::stdout().flush()?;
    fs::write(call.join("completed-unix-ms"), timestamp())?;
    fs::write(call.join("intended-exit-code"), code.to_string())?;
    Ok(code)
}

fn main() {
    let code = main_inner().unwrap_or_else(|error| {
        eprintln!("清理重试独立夹具失败：{error}");
        93
    });
    std::process::exit(code);
}
