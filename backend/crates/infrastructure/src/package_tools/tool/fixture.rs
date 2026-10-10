//! 独立工具夹具；通过文件握手保持真实进程在途。
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("fail") {
        eprintln!("工具拒绝");
        std::process::exit(2);
    }
    if args.first().map(String::as_str) == Some("ready") {
        std::fs::write(&args[1], std::process::id().to_string()).unwrap();
        let start = std::time::Instant::now();
        while !std::path::Path::new(&args[2]).exists() {
            assert!(start.elapsed() < std::time::Duration::from_secs(10));
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }
    print!("完成");
}
