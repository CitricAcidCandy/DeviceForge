use std::{fs, io::{self, Write}, path::Path, thread, time::{Duration, Instant}};

fn escaped(value: &str) -> String {
    let mut output = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            value if value.is_control() => output.push_str(&format!("\\u{:04x}", value as u32)),
            value => output.push(value),
        }
    }
    output.push('"');
    output
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = std::env::current_exe().unwrap().parent().unwrap().canonicalize().unwrap();
    let (directory, ordinal) = (1..=32).find_map(|ordinal| {
        let directory = root.join(format!("call-{ordinal:02}"));
        match fs::create_dir(&directory) {
            Ok(()) => Some((directory, ordinal)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => None,
            Err(error) => panic!("观测目录创建失败：{error}"),
        }
    }).expect("工具调用须有界");
    let status = args == ["--version"];
    let record = args.iter().find_map(|value| value.strip_prefix("--record="));
    assert!(status || record.is_some(), "只允许公开版本或录像参数");
    if let Some(path) = record {
        assert!(Path::new(path).is_absolute());
        let bytes = fs::read(root.join(if ordinal == 5 { "invalid.mp4" } else { "expected.mp4" })).unwrap();
        fs::write(path, &bytes).unwrap();
        fs::write(directory.join("observed.mp4"), bytes).unwrap();
    }
    let ready = format!("{{\"pid\":{},\"argv\":[{}],\"adb\":{}}}\n", std::process::id(),
        args.iter().map(|value| escaped(value)).collect::<Vec<_>>().join(","), escaped(&std::env::var("ADB").unwrap_or_default()));
    fs::write(directory.join("ready.tmp"), ready).unwrap();
    fs::rename(directory.join("ready.tmp"), directory.join("ready.json")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !directory.join("release").exists() {
        if Instant::now() >= deadline { std::process::exit(90); }
        thread::sleep(Duration::from_millis(2));
    }
    io::stdout().write_all(if status { b"scrcpy 3.2\n" } else { b"synthetic recording complete\n" }).unwrap();
    io::stdout().flush().unwrap();
}
