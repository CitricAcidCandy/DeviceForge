// 模拟 bundletool：验证独立 argv 与密码文件参数；生成测试 APKS，不代表真实 AAB 转换。
use std::{fs, path::Path, time::Duration};
fn crc(bytes: &[u8]) -> u32 {
    let mut value = !0u32;
    for byte in bytes { value ^= *byte as u32; for _ in 0..8 { value = (value >> 1) ^ if value & 1 != 0 { 0xedb88320 } else { 0 }; } }
    !value
}
fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut local = Vec::new(); let mut central = Vec::new();
    for (name, data) in entries {
        let offset = local.len() as u32; let size = data.len() as u32; let checksum = crc(data);
        local.extend_from_slice(&0x04034b50u32.to_le_bytes());
        for v in [20u16, 0, 0, 0, 0] { local.extend_from_slice(&v.to_le_bytes()); }
        for v in [checksum, size, size] { local.extend_from_slice(&v.to_le_bytes()); }
        local.extend_from_slice(&(name.len() as u16).to_le_bytes()); local.extend_from_slice(&0u16.to_le_bytes());
        local.extend_from_slice(name.as_bytes()); local.extend_from_slice(data);
        central.extend_from_slice(&0x02014b50u32.to_le_bytes());
        for v in [20u16, 20, 0, 0, 0, 0] { central.extend_from_slice(&v.to_le_bytes()); }
        for v in [checksum, size, size] { central.extend_from_slice(&v.to_le_bytes()); }
        for v in [name.len() as u16, 0, 0, 0, 0] { central.extend_from_slice(&v.to_le_bytes()); }
        central.extend_from_slice(&0u32.to_le_bytes()); central.extend_from_slice(&offset.to_le_bytes()); central.extend_from_slice(name.as_bytes());
    }
    let offset = local.len() as u32; let size = central.len() as u32; local.extend_from_slice(&central);
    local.extend_from_slice(&0x06054b50u32.to_le_bytes());
    for v in [0u16, 0, entries.len() as u16, entries.len() as u16] { local.extend_from_slice(&v.to_le_bytes()); }
    local.extend_from_slice(&size.to_le_bytes()); local.extend_from_slice(&offset.to_le_bytes()); local.extend_from_slice(&0u16.to_le_bytes()); local
}
pub fn run(mode: &str, args: &[String]) {
    assert!(std::env::var_os("APK_API_TOKEN").is_none());
    assert_eq!(args.len(), 9); assert_eq!(args[0], "build-apks"); assert_eq!(args[4], "--max-threads=2");
    let input = args[1].strip_prefix("--bundle=").unwrap(); let output = args[2].strip_prefix("--output=").unwrap();
    assert!(input.ends_with(".aab")); assert!(output.ends_with(".apks"));
    assert_eq!(Path::new(input).parent(), Some(std::env::current_dir().unwrap().as_path()));
    assert!(!Path::new(output).exists());
    assert!(Path::new(args[5].strip_prefix("--ks=").unwrap()).is_file());
    assert!(args[6].starts_with("--ks-key-alias="));
    for argument in &args[7..9] {
        let path = argument.split_once("=file:").unwrap().1; assert!(Path::new(path).is_file());
    }
    let bytes = fs::read(input).unwrap();
    if mode == "fail" { eprintln!("签名诊断不可对外公开 {:?}", args); std::process::exit(2); }
    if mode == "missing" { return; }
    if mode == "large" { fs::File::create(output).unwrap().set_len(65*1024*1024).unwrap(); std::thread::sleep(Duration::from_secs(10)); return; }
    if mode == "slow" {
        let marker = format!("{}.started", args[5].strip_prefix("--ks=").unwrap());
        let temporary = format!("{marker}.tmp");
        // 先完整写入再同目录发布，避免并行测试读到已创建但尚未写入的空标记。
        fs::write(&temporary, input).unwrap();
        fs::rename(&temporary, &marker).unwrap();
        std::thread::sleep(Duration::from_secs(10));
    }
    let entries: Vec<(&str, &[u8])> = match mode {
        "bad-toc" => vec![("universal.apk", &bytes)],
        "bad-apk" => vec![("toc.pb", b"toc"), ("universal.apk", b"invalid")],
        "duplicate" => vec![("toc.pb", b"toc"), ("universal.apk", &bytes), ("universal.apk", &bytes)],
        "traversal" => vec![("toc.pb", b"toc"), ("../universal.apk", &bytes)],
        _ if args[3] == "--mode=universal" => vec![("toc.pb", b"toc"), ("universal.apk", &bytes)],
        _ => vec![("toc.pb", b"toc"), ("splits/base-master.apk", &bytes), ("splits/base-arm64.apk", &bytes)],
    };
    let mut result = zip(&entries);
    if mode == "crc" { result[36] ^= 1; }
    fs::write(output, result).unwrap();
}
#[allow(dead_code)]
fn main() { let args: Vec<String> = std::env::args().skip(1).collect(); run(&args[0], &args[1..]); }
