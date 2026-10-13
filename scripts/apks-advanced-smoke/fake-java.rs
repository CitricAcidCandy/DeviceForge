use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

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

fn argument(args: &[String], name: &str) -> PathBuf {
    PathBuf::from(args.iter().find_map(|value| value.strip_prefix(name)).expect("必须提供固定路径参数"))
}

fn observations(root: &Path) -> PathBuf {
    for ordinal in 1..=64 {
        let path = root.join(format!("call-{ordinal:02}"));
        match fs::create_dir(&path) {
            Ok(()) => return path,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(error) => panic!("无法创建夹具观测目录：{error}"),
        }
    }
    panic!("夹具调用次数超限")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = std::env::current_exe().unwrap().parent().unwrap().canonicalize().unwrap();
    let directory = observations(&root);
    let command = if args == ["devices", "-l"] {
        "discover"
    } else {
        assert!(args.len() >= 7);
        assert_eq!(&args[..2], ["-Xmx256m", "-jar"]);
        assert!(Path::new(&args[2]).is_absolute() && fs::metadata(&args[2]).unwrap().is_file());
        assert!(matches!(args[3].as_str(), "extract-apks" | "install-apks"));
        fs::copy(argument(&args, "--apks="), directory.join("input.bin")).unwrap();
        if args[3] == "extract-apks" {
            fs::copy(argument(&args, "--device-spec="), directory.join("device-spec.json")).unwrap();
        }
        args[3].as_str()
    };
    let cwd = std::env::current_dir().unwrap();
    let ready = format!(
        "{{\"pid\":{},\"command\":{},\"argv\":[{}],\"cwd\":{},\"temp\":{},\"tmp\":{},\"tmpdir\":{}}}\n",
        std::process::id(), escaped(command),
        args.iter().map(|value| escaped(value)).collect::<Vec<_>>().join(","),
        escaped(cwd.to_str().unwrap()), escaped(&std::env::var("TEMP").unwrap_or_default()),
        escaped(&std::env::var("TMP").unwrap_or_default()), escaped(&std::env::var("TMPDIR").unwrap_or_default())
    );
    fs::write(directory.join("ready.json.tmp"), ready).unwrap();
    fs::rename(directory.join("ready.json.tmp"), directory.join("ready.json")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !directory.join("release").exists() {
        if Instant::now() >= deadline { std::process::exit(90); }
        thread::sleep(Duration::from_millis(5));
    }
    if command == "extract-apks" {
        let output = argument(&args, "--output-dir=");
        fs::create_dir(&output).unwrap();
        fs::create_dir(output.join("features")).unwrap();
        fs::copy(root.join("base.apk"), output.join("base-master.apk")).unwrap();
        fs::copy(root.join("feature.apk"), output.join("features/feature_1.apk")).unwrap();
        io::stdout().write_all(b"synthetic extraction complete\n").unwrap();
    } else if command == "install-apks" {
        io::stdout().write_all(b"installation complete\n").unwrap();
    } else {
        io::stdout().write_all("List of devices attached\n模拟:甲\tdevice model:公开APKS夹具\n".as_bytes()).unwrap();
    }
    io::stdout().flush().unwrap();
}
