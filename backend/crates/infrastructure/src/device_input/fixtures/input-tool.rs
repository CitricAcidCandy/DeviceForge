use std::{fs::OpenOptions, io::Write, time::Duration};

mod shell_words;
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert_eq!(args[0], "-s");
    assert_eq!(&args[2..5], &["shell", "-T", "input"]);
    let directory = std::env::temp_dir().join(&args[1]);
    let mut log = OpenOptions::new().create(true).append(true).open(directory.join("observed")).unwrap();
    let words = shell_words::shell_words(&args[4..].join(" "));
    assert_eq!(words[0], "input");
    match words[1].as_str() {
        "text" => { assert_eq!(words.len(), 3); write!(log, "{}", words[2].replace("%s", " ")).unwrap(); }
        "tap" | "swipe" => { writeln!(log, "{}:{}", words[1], words[2..].join(",")).unwrap(); }
        "keyevent" => { write!(log, "<{}>", words[2..].join(",")).unwrap(); }
        _ => panic!("非预期输入命令"),
    }
    log.flush().unwrap();
    if args[1].starts_with("slow.") { std::thread::sleep(Duration::from_secs(30)); }
    if args[1].starts_with("stdout.") { println!("Error: injecting input requires permission"); }
    if args[1].starts_with("stderr.") { eprintln!("SecurityException: injecting input requires permission"); }
    if args[1].starts_with("exit.") { eprintln!("设备离线"); std::process::exit(1); }
}