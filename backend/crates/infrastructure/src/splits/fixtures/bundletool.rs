// 独立模拟 bundletool 分包操作，校验固定参数、环境和临时目录。
use std::{fs, path::Path, time::Duration};
fn publish_marker(marker: &str, input: &str) {
    let temporary = format!("{marker}.tmp");
    // 读取方只观察已写完的文件，避免启动标记创建与写入之间的并发窗口。
    fs::write(&temporary, input).unwrap();
    fs::rename(&temporary, marker).unwrap();
}
pub fn run(mode: &str, args: &[String]) {
    let (mode, external_marker) = mode.split_once('=').map(|(mode, path)| (mode, Some(path))).unwrap_or((mode, None));
    assert!(std::env::var_os("APK_API_TOKEN").is_none());
    assert_eq!(args.len(), 4);
    let input = args[1].strip_prefix("--apks=").unwrap();
    assert!(input.ends_with(".apks")); assert!(fs::read(input).unwrap().starts_with(b"PK"));
    assert_eq!(Path::new(input).parent(), Some(std::env::current_dir().unwrap().as_path()));
    if mode == "fail" { eprintln!("模拟诊断包含服务器路径 {input}"); std::process::exit(2); }
    if mode == "false-success" { eprintln!("Error: INSTALL_FAILED_INVALID_APK"); return; }
    if args[0] == "install-apks" {
        let device = args[2].strip_prefix("--device-id=").unwrap();
        assert!(!device.starts_with('-')); assert!(!device.is_empty());
        let adb = args[3].strip_prefix("--adb=").unwrap(); assert!(!adb.is_empty());
        let marker = format!("{adb}.{}.started", device.replace(':', "_")); publish_marker(&marker, input);
        if mode == "slow" || device == "slow" { std::thread::sleep(Duration::from_secs(10)); }
        if device == "offline" { eprintln!("device offline"); return; }
        return;
    }
    assert_eq!(args[0], "extract-apks");
    let output = args[2].strip_prefix("--output-dir=").unwrap();
    let spec_path = args[3].strip_prefix("--device-spec=").unwrap();
    assert_eq!(Path::new(output).parent(), Path::new(input).parent());
    let spec = fs::read_to_string(spec_path).unwrap();
    for key in ["supportedAbis", "supportedLocales", "screenDensity", "sdkVersion"] { assert!(spec.contains(key)); }
    assert!(!spec.contains("supported_abis"));
    if mode == "missing" { return; }
    fs::create_dir_all(output).unwrap();
    let input_bytes = fs::read(input).unwrap();
    // 模拟输入使用 Stored ZIP，查找嵌套 APK 头以保留可校验容器。
    let nested = input_bytes.windows(19).position(|value| value == b"AndroidManifest.xml").unwrap() - 30;
    let end = nested + input_bytes[nested..].windows(4).position(|value| value == b"PK\x05\x06").unwrap() + 22;
    let apk = &input_bytes[nested..end];
    fs::write(Path::new(output).join("base-master.apk"), apk).unwrap();
    if spec.contains("arm64-v8a") { fs::write(Path::new(output).join("base-arm64.apk"), apk).unwrap(); }
    if mode == "bad-apk" { fs::write(Path::new(output).join("bad.apk"), b"invalid").unwrap(); }
    if mode == "extra" { fs::write(Path::new(output).join("extra.txt"), b"invalid").unwrap(); }
    if mode == "large" { fs::File::create(Path::new(output).join("large.apk")).unwrap().set_len(65*1024*1024).unwrap(); std::thread::sleep(Duration::from_secs(10)); }
    if mode == "slow" {
        let marker = external_marker.map(str::to_owned).unwrap_or_else(|| format!("{spec_path}.started"));
        publish_marker(&marker, input);
        std::thread::sleep(Duration::from_secs(10));
    }
}
#[allow(dead_code)]
fn main() { let args: Vec<String> = std::env::args().skip(1).collect(); run(&args[0], &args[1..]); }
