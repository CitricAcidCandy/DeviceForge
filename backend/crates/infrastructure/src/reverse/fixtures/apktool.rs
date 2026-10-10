// 独立模拟 Apktool，确认临时输出和 framework 参数，并覆盖失败及取消。
use std::{fs,path::PathBuf,time::Duration};
pub fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mode = if args[0] == "-Xmx256m" {
        assert_eq!(args[1], "-jar");
        assert_eq!(PathBuf::from(&args[2]).file_name().and_then(|name| name.to_str()), Some("mock-apktool.jar"));
        args.drain(..3);
        "ok".to_owned()
    } else { args.remove(0) };
    assert_eq!(args.len(),6);
    assert_eq!(args[0],"decode");
    assert!(fs::read(&args[1]).unwrap().starts_with(b"PK"));
    assert_eq!(args[2],"--output");
    assert_eq!(args[4],"--frame-path");
    let output = PathBuf::from(&args[3]);
    let framework = PathBuf::from(&args[5]);
    assert_eq!(output.parent(),framework.parent());
    assert!(!output.exists());
    if mode == "exit" { eprintln!("模拟反编译失败"); std::process::exit(2); }
    if mode == "silent" { return; }
    fs::create_dir_all(&output).unwrap();
    fs::write(output.join("apktool.yml"),"version: 2.9.0").unwrap();
    fs::write(output.join("AndroidManifest.xml"),"<manifest package='com.example.app'/>").unwrap();
    let source = output.join("smali_classes2/com/example/sdk");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("Entry$Inner.smali"),".class public Lcom/example/sdk/Entry$Inner;").unwrap();
    if mode == "large" {
        fs::File::create(output.join("large")).unwrap().set_len(65*1024*1024).unwrap();
        std::thread::sleep(Duration::from_secs(10));
    }
    if mode == "slow" { std::thread::sleep(Duration::from_secs(10)); }
    println!("反编译完成");
}
