//! std-only 独立假工具；配置通过可执行文件位置关联本次观察目录，不借助宿主环境。
use std::{fs, io::{self, Write}, path::{Path, PathBuf}, thread, time::{Duration, Instant}};

fn publish(root: &Path, name: &str, bytes: &[u8]) {
    let temporary = root.join(format!("{name}.tmp"));
    fs::write(&temporary, bytes).expect("写完整本次标记");
    fs::rename(&temporary, root.join(name)).expect("原子发布本次标记");
}
fn option<'a>(argument: &'a str, prefix: &str) -> &'a str { argument.strip_prefix(prefix).expect("原固定 argv 参数") }

fn main() {
    let root = std::env::current_exe().unwrap().parent().unwrap().canonicalize().unwrap();
    let args: Vec<String> = std::env::args().skip(1).collect();
    publish(&root, "started.pid", std::process::id().to_string().as_bytes());
    fs::write(root.join("argv.txt"), args.join("\n")).unwrap();
    let business = if args.first().is_some_and(|arg| arg == "-Xmx256m") {
        assert_eq!(args[1], "-jar");
        let jar = Path::new(&args[2]);
        assert!(jar.is_absolute() && jar.is_file());
        assert!(jar == root.join("bundletool.jar") || jar == root.join("apktool.jar"));
        &args[3..]
    } else { &args[..] };
    let (input, output) = match business[0].as_str() {
        "manifest" => {
            assert_eq!(business.len(), 3); assert_eq!(business[1], "print");
            (&business[2][..], None)
        }
        "verify" => {
            assert_eq!(business.len(), 4); assert_eq!(business[1], "--verbose"); assert_eq!(business[2], "--print-certs");
            (&business[3][..], None)
        }
        "dump" => {
            assert_eq!(business.len(), 4); assert_eq!(business[1], "manifest");
            assert!(business[3] == "--module=base" || business[3] == "--module=feature_test");
            (option(&business[2], "--bundle="), None)
        }
        "build-apks" => {
            assert_eq!(business.len(), 9); assert_eq!(business[4], "--max-threads=2");
            assert!(business[3] == "--mode=universal" || business[3] == "--mode=default");
            assert_eq!(business[5], format!("--ks={}", root.join("keystore.jks").display()));
            assert_eq!(business[6], "--ks-key-alias=fixture_中文_&$()");
            assert_eq!(business[7], format!("--ks-pass=file:{}", root.join("store.pass").display()));
            assert_eq!(business[8], format!("--key-pass=file:{}", root.join("key.pass").display()));
            (option(&business[1], "--bundle="), Some(option(&business[2], "--output=")))
        }
        "decode" => {
            assert_eq!(business.len(), 6); assert_eq!(business[2], "--output"); assert_eq!(business[4], "--frame-path");
            assert_eq!(Path::new(&business[3]).parent(), Path::new(&business[5]).parent());
            (&business[1][..], Some(&business[3][..]))
        }
        "extract-apks" => {
            assert_eq!(business.len(), 4);
            let spec = option(&business[3], "--device-spec=");
            fs::copy(spec, root.join("device-spec.json")).unwrap();
            (option(&business[1], "--apks="), Some(option(&business[2], "--output-dir=")))
        }
        _ => panic!("不是本批七操作的固定工具命令"),
    };
    let input_path = Path::new(input);
    assert_eq!(fs::read(input_path).unwrap(), fs::read(root.join("expected-input.bin")).unwrap(), "工具核对原输入字节");
    let private_root = root.parent().unwrap().join("私有任务");
    assert!(input_path.starts_with(&private_root), "工具不能取得宿主输入或输出目录");
    if let Some(output) = output {
        assert!(Path::new(output).starts_with(input_path.parent().unwrap()));
        assert!(!Path::new(output).exists(), "ready 前不伪造最终产物");
    }
    fs::write(root.join("input-path.txt"), input).unwrap();
    publish(&root, "ready.pid", std::process::id().to_string().as_bytes());
    if fs::read_to_string(root.join("mode.txt")).unwrap().trim() != "immediate" {
        let guard = Instant::now() + Duration::from_secs(60);
        while !root.join("release").exists() {
            if Instant::now() >= guard { std::process::exit(90); }
            thread::sleep(Duration::from_millis(5));
        }
    }
    let mode = fs::read_to_string(root.join("mode.txt")).unwrap();
    if mode.trim() == "nonzero" {
        eprintln!("独立工具非零诊断哨兵，不能进入公开响应"); std::process::exit(7);
    }
    match business[0].as_str() {
        "manifest" | "dump" => { io::stdout().write_all(&fs::read(root.join("manifest.xml")).unwrap()).unwrap(); }
        "verify" => { io::stdout().write_all(&fs::read(root.join("signature.txt")).unwrap()).unwrap(); }
        "build-apks" => {
            let source = if business[3] == "--mode=universal" { "universal.apks" } else { "default.apks" };
            fs::copy(root.join(source), output.unwrap()).unwrap();
        }
        "decode" => {
            let destination = PathBuf::from(output.unwrap());
            for (source, name) in [("decoded-manifest.xml", "AndroidManifest.xml"), ("apktool.yml", "apktool.yml"), ("Probe.smali", "smali/com/example/sdk/Probe.smali")] {
                let target = destination.join(name); fs::create_dir_all(target.parent().unwrap()).unwrap();
                fs::copy(root.join(source), target).unwrap();
            }
        }
        "extract-apks" => {
            let destination = PathBuf::from(output.unwrap()); fs::create_dir(&destination).unwrap();
            for name in ["base-master.apk", "base-arm64.apk"] { fs::copy(root.join(name), destination.join(name)).unwrap(); }
        }
        _ => unreachable!(),
    }
    io::stdout().flush().unwrap();
    publish(&root, "response_written", b"1");
    // 此标记只表示退出意图；调用方另持同 PID 的系统等待句柄。
    publish(&root, "exit.code", b"0");
}
