//! 独立原生假ADB；只按固定参数输出黄金文本，记录argv并在OS探针门闩后继续。
use std::{env, fs, io::{self, Write}, path::{Path, PathBuf}, thread, time::{Duration, Instant}};

fn call_directory(root: &Path) -> io::Result<(PathBuf, u64)> {
    for number in 1..=256_u64 {
        let directory = root.join(format!("call-{number:03}"));
        match fs::create_dir(&directory) {
            Ok(()) => return Ok((directory, number)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::other("夹具调用超过256笔"))
}

fn argv_bytes(args: &[String]) -> Vec<u8> {
    let mut bytes = Vec::new(); bytes.extend_from_slice(&(args.len() as u32).to_le_bytes());
    for arg in args { bytes.extend_from_slice(&(arg.len() as u32).to_le_bytes()); bytes.extend_from_slice(arg.as_bytes()); }
    bytes
}

fn run() -> io::Result<()> {
    let root = env::current_exe()?.parent().expect("工具须有父目录").to_owned();
    let args: Vec<String> = env::args().skip(1).collect();
    assert!(args.len() <= 12 && args.iter().all(|part| part.len() <= 4096));
    let tail = if args.len() >= 4 && args[0] == "-s" && args[2] == "shell" {
        assert_eq!(args[1], "observation-0001");
        if args[3] == "-T" { &args[4..] } else { &args[3..] }
    } else { &args[..] };
    let category = match tail {
        [a, b] if a == "devices" && b == "-l" => "discover",
        [a, b, package] if a == "pidof" && b == "-s" => { assert!(package.starts_with("org.smoke.observation.")); "pid" },
        [a, b] if a == "cat" && b == "/proc/2468/stat" => "process",
        [a, b] if a == "cat" && b == "/proc/stat" => "system",
        [a, b] if a == "cat" && b == "/sys/class/power_supply/battery/uevent" => "uevent",
        [a, b, c, d] if a == "dumpsys" && b == "meminfo" && c == "-s" && d == "2468" => "memory",
        [a, b, c] if a == "dumpsys" && b == "SurfaceFlinger" && c == "--list" => "surface-list",
        [a, b] if a == "dumpsys" && b == "battery" => "battery",
        [a, b] if a == "dumpsys" && b == "thermalservice" => "thermal",
        _ => return Err(io::Error::other("假ADB拒绝未冻结的参数")),
    };
    let (call, number) = call_directory(&root)?;
    fs::write(call.join("argv.bin"), argv_bytes(&args))?;
    fs::write(call.join("pid"), std::process::id().to_string())?;
    fs::write(call.join("category"), category)?;
    fs::write(call.join("ready"), "1")?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while !call.join("release").exists() {
        if Instant::now() >= deadline { return Err(io::Error::new(io::ErrorKind::TimedOut, "OS探针门闩超时")); }
        thread::sleep(Duration::from_millis(5));
    }
    let mode = fs::read_to_string(root.join("mode"))?;
    let text = match category {
        "discover" => "List of devices attached\nobservation-0001 device product:golden model:黄金设备 transport_id:1\n".to_owned(),
        "pid" => "2468\n".to_owned(),
        "process" => {
            let mut fields = vec!["0".to_owned(); 20]; fields[0] = "R".into();
            fields[11] = (100 + number * 10).to_string(); fields[19] = "900".into();
            format!("2468 (observation game) {}\n", fields.join(" "))
        },
        "system" => format!("cpu {} 0 0 1000\ncpu0 1 0 0 1\ncpu1 1 0 0 1\n", 10000 + number * 100),
        "memory" => "** MEMINFO in pid 2468 [org.smoke.observation.game] **\nTOTAL PSS: 2048 TOTAL RSS: 4096\n".to_owned(),
        "surface-list" => String::new(),
        "uevent" | "battery" | "thermal" => fs::read_to_string(root.join("inputs").join(mode.trim()).join(format!("{category}.txt")))?,
        _ => unreachable!(),
    };
    fs::write(call.join("stdout.bin"), text.as_bytes())?;
    io::stdout().write_all(text.as_bytes())?; io::stdout().flush()?;
    fs::write(call.join("completed"), "1")?; Ok(())
}

fn main() {
    if let Err(error) = run() { eprintln!("独立观测夹具失败：{error}"); std::process::exit(2); }
}
