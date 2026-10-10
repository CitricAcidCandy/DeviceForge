// 模拟工具独立进程，用于检查参数、退出状态和原始截图字节。
use std::{io::Write, time::Duration};
#[path = "../../device_input/fixtures/shell_words.rs"]
mod shell_words;
#[path = "../../performance/fixtures/probe.rs"]
mod performance_probe;
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["devices", "-l"] {
        // offline 是已观测在线设备；由假 Java 返回离线诊断，验证 APKS 输出失败规则。
        println!("List of devices attached\ninput-ok\tdevice model:fixture\ninput-error\tdevice model:fixture\nok\tdevice model:fixture\nstderr-failure\tdevice model:fixture\noffline\tdevice model:fixture");
        return;
    }
    if args == ["list", "targets"] {
        println!("ok\nstderr-failure");
        return;
    }
    assert!(args.len() >= 3);
    assert!(args[0] == "-s" || args[0] == "-t");
    let mode = &args[1];
    if mode.starts_with("perf.") { performance_probe::run(&args); return; }
    if mode == "sleep" {
        std::thread::sleep(Duration::from_secs(10));
    }
    if mode == "exit" {
        eprintln!("模拟工具非零退出");
        std::process::exit(2);
    }
    if mode == "failure" {
        println!("Failure [INSTALL_FAILED_INVALID_APK]");
        return;
    }
    if mode == "stderr-failure" {
        println!("Success");
        eprintln!("error: device offline");
        return;
    }
    if mode == "silent" { return; }
    match args[2].as_str() {
        "shell" if mode.starts_with("input-") => {
            assert_eq!(&args[2..5], &["shell", "-T", "input"]);
            let words = shell_words::shell_words(&args[4..].join(" "));
            let value = match words[1].as_str() {
                "tap" => { assert_eq!(words.len(), 4); format!("tap:{}", words[2..].join(",")) }
                "swipe" => { assert_eq!(words.len(), 7); format!("swipe:{}", words[2..].join(",")) }
                "keyevent" => format!("keyevent:{}", words[2..].join(",")),
                "text" => { assert_eq!(words.len(), 3); format!("text:{}", words[2].replace("%s", " ")) }
                _ => panic!("非预期输入命令"),
            };
            let marker = std::env::current_exe().unwrap().parent().unwrap().join("input-observed");
            let mut log = std::fs::OpenOptions::new().create(true).append(true).open(marker).unwrap();
            writeln!(log, "{value}").unwrap();
            if mode == "input-error" { eprintln!("SecurityException: permission denied"); }
        }
        "install" => {
            assert_eq!(args.len(), 4);
            let bytes = std::fs::read(&args[3]).unwrap();
            assert!(bytes.starts_with(b"PK"));
            println!("temporary:{}", args[3]);
            let marker = std::env::current_exe().unwrap().parent().unwrap().join("installation-path");
            std::fs::write(marker, &args[3]).unwrap();
            if mode == "sleep-install" {
                let _held = std::fs::File::open(&args[3]).unwrap();
                std::thread::sleep(Duration::from_secs(10));
            }
            if args[0] == "-t" {
                println!("[Info]App install path:{} msg:install bundle successfully.", args[3]);
            } else { println!("Success"); }
        }
        "uninstall" => {
            assert_eq!(args.len(), 4);
            assert_eq!(args[3], "com.example.app");
            if args[0] == "-t" {
                println!("[Info]App uninstall path: msg:uninstall bundle successfully.");
            } else { println!("Success"); }
        }
        "exec-out" => {
            assert_eq!(args, ["-s", mode.as_str(), "exec-out", "screencap", "-p"]);
            let mut output = std::io::stdout().lock();
            if mode == "large" { output.write_all(&vec![0; 2 * 1024 * 1024]).unwrap(); }
            else if mode == "invalid" { output.write_all(b"not a png").unwrap(); }
            else { output.write_all(include_bytes!("pixel.png")).unwrap(); }
        }
        _ => panic!("模拟工具收到未预期的参数"),
    }
}
