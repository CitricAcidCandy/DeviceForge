// 自包含模拟工具：真实进程读取宿主副本并写固定产物，不证明 Android 工具能力。
use std::{fs, path::{Path, PathBuf}, time::{Duration, Instant}};

fn publish(root: &Path, name: &str, bytes: &[u8]) {
    let temporary = root.join(format!("{name}.tmp"));
    fs::write(&temporary, bytes).expect("先写完整本次标记");
    fs::rename(temporary, root.join(name)).expect("原子发布本次标记");
}

fn option<'a>(argument: &'a str, prefix: &str) -> &'a str {
    argument.strip_prefix(prefix).expect("固定独立 argv 参数")
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    assert!(arguments.len() >= 3, "固定前缀和业务 argv");
    let mode = &arguments[0];
    assert!(mode == "hold" || mode == "response");
    let root = PathBuf::from(&arguments[1]);
    publish(&root, "started.pid", std::process::id().to_string().as_bytes());
    let request = &arguments[2..];
    let (input, output) = match request[0].as_str() {
        "build-apks" => {
            assert_eq!(request.len(), 9);
            assert_eq!(request[4], "--max-threads=2");
            let input = option(&request[1], "--bundle=");
            let output = option(&request[2], "--output=");
            assert!(input.ends_with(".aab") && output.ends_with(".apks"));
            assert!(request[3] == "--mode=default" || request[3] == "--mode=universal");
            assert!(Path::new(option(&request[5], "--ks=")).is_file());
            assert_eq!(request[6], "--ks-key-alias=remaining-fixture");
            assert!(Path::new(option(&request[7], "--ks-pass=file:")).is_file());
            assert!(Path::new(option(&request[8], "--key-pass=file:")).is_file());
            assert_eq!(Path::new(input).parent(), Some(std::env::current_dir().unwrap().as_path()));
            (input, output)
        }
        "decode" => {
            assert_eq!(request.len(), 6);
            assert_eq!(request[2], "--output");
            assert_eq!(request[4], "--frame-path");
            assert!(request[1].ends_with(".apk"));
            assert_eq!(Path::new(&request[3]).parent(), Path::new(&request[5]).parent());
            (&request[1][..], &request[3][..])
        }
        "extract-apks" => {
            assert_eq!(request.len(), 4);
            let input = option(&request[1], "--apks=");
            let output = option(&request[2], "--output-dir=");
            let spec = option(&request[3], "--device-spec=");
            assert!(input.ends_with(".apks"));
            assert_eq!(Path::new(input).parent(), Some(std::env::current_dir().unwrap().as_path()));
            assert_eq!(Path::new(input).parent(), Path::new(spec).parent());
            fs::copy(spec, root.join("device-spec.json")).expect("记录本次实际规格文件");
            (input, output)
        }
        _ => panic!("不接受非本批纯包操作"),
    };
    assert_eq!(Path::new(input).parent(), Path::new(output).parent());
    assert_eq!(fs::read(input).expect("真实宿主副本"), fs::read(root.join("expected-input.bin")).unwrap());
    assert!(!Path::new(output).exists(), "ready 前不能伪造最终输出");
    fs::write(root.join("argv.txt"), request.join("\n")).expect("本次非敏感固定 argv");
    fs::write(root.join("input-path.txt"), input).expect("本次宿主副本位置");
    publish(&root, "ready.pid", std::process::id().to_string().as_bytes());
    if mode == "hold" {
        let limit = Instant::now() + Duration::from_secs(60);
        while !root.join("release").exists() {
            if Instant::now() >= limit {
                eprintln!("独立工具门闩看门狗到期");
                std::process::exit(90);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    match request[0].as_str() {
        "build-apks" => {
            let filename = if request[3] == "--mode=universal" { "universal.apks" } else { "default.apks" };
            fs::copy(root.join(filename), output).expect("工具生成固定 APKS 原字节");
        }
        "decode" => {
            fs::create_dir_all(output).expect("生成反编译根");
            let list = fs::read_to_string(root.join("decoded-files.txt")).unwrap();
            for name in list.lines() {
                let destination = Path::new(output).join(name);
                fs::create_dir_all(destination.parent().unwrap()).expect("固定子目录");
                fs::copy(root.join("decoded-template").join(name), destination).expect("固定文件原字节");
            }
        }
        "extract-apks" => {
            fs::create_dir_all(output).expect("生成分包根");
            for name in ["base-master.apk", "base-arm64.apk"] {
                fs::copy(root.join(name), Path::new(output).join(name)).expect("固定结构 APK");
            }
        }
        _ => unreachable!(),
    }
    publish(&root, "response_written", b"1");
    // 退出标记仅表示意图；调用方仍独立探测同一 PID 是否退出。
    publish(&root, "exit.code", b"0");
}
