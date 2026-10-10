mod split_tool { include!("../../splits/fixtures/bundletool.rs"); }
mod bundle_build { include!("../../bundles/fixtures/bundletool.rs"); }
mod reverse_tool { include!("../../reverse/fixtures/apktool.rs"); }
// 独立模拟分析工具；固定前缀模拟部署配置，不从请求读取工具命令。
fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let jar_name = args.get(2).and_then(|path| std::path::Path::new(path).file_name())
        .and_then(|name| name.to_str());
    if jar_name == Some("mock-apktool.jar") {
        reverse_tool::main();
        return;
    }
    if args.first().map(String::as_str) == Some("-Xmx256m") {
        assert_eq!(args[1], "-jar");
        assert_eq!(jar_name, Some("mock-bundletool.jar"));
        args.drain(..3);
        if args.first().map(String::as_str) == Some("build-apks") { bundle_build::run("ok", &args); return; }
        if matches!(args.first().map(String::as_str), Some("install-apks" | "extract-apks")) { split_tool::run("ok", &args); return; }
        args.insert(0, "bundle".into());
    } else if args.first().map(String::as_str) == Some("verify") {
        args.insert(0, "signature".into());
    } else if args.get(1).map(String::as_str) == Some("print") {
        args.insert(0, "manifest".into());
    }
    match args[0].as_str() {
        "manifest" => {
            assert_eq!(&args[1..3], ["manifest", "print"]);
            assert_eq!(args.len(), 4);
            assert!(std::fs::read(&args[3]).unwrap().starts_with(b"PK"));
            assert!(args[3].ends_with(".apk"));
            print!("{}", include_str!("manifest.xml"));
        }
        "signature" => {
            assert_eq!(&args[1..4], ["verify", "--verbose", "--print-certs"]);
            assert_eq!(args.len(), 5);
            assert!(std::fs::read(&args[4]).unwrap().starts_with(b"PK"));
            assert!(args[4].ends_with(".apk"));
            print!("{}", include_str!("signature.txt"));
        }
        "bundle" => {
            assert_eq!(&args[1..3], ["dump", "manifest"]);
            assert_eq!(args.len(), 5);
            let path = args[3].strip_prefix("--bundle=").unwrap();
            assert!(path.ends_with(".aab"));
            assert!(std::fs::read(path).unwrap().starts_with(b"PK"));
            assert!(args[4].starts_with("--module="));
            print!("{}", include_str!("manifest.xml"));
        }
        "silent" => (),
        "invalid" => print!("不是有效分析结果"),
        "nonzero" => { eprintln!("模拟工具拒绝包体"); std::process::exit(2); }
        "slow" => std::thread::sleep(std::time::Duration::from_secs(10)),
        _ => panic!("收到未预期的模拟工具模式"),
    }
}
