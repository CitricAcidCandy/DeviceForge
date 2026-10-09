use std::{fs, time::Duration};
fn stat(pid: &str, ticks: u64) -> String {
    let mut fields = vec!["0".to_owned(); 22];
    fields[0] = "S".into(); fields[11] = ticks.to_string(); fields[12] = "5".into(); fields[19] = "900".into();
    format!("{pid} (name ) with spaces) {}", fields.join(" "))
}
pub fn run(args: &[String]) {
    assert_eq!(&args[..1], &["-s"]);
    assert_eq!(&args[2..4], &["shell","-T"]);
    if args[1].starts_with("slow.") { std::thread::sleep(Duration::from_secs(30)); }
    if args[1].starts_with("denied.") { println!("Permission denied"); return; }
    if args[1].starts_with("exit.") { eprintln!("设备离线"); std::process::exit(1); }
    let directory = if args[1].starts_with("perf.") {
        let path = std::env::current_exe().unwrap().parent().unwrap().join(&args[1]);
        fs::create_dir_all(&path).unwrap();
        path
    } else { std::env::temp_dir().join(&args[1]) };
    match args[4].as_str() {
        "pidof" => { assert_eq!(&args[5..], &["-s","com.example.app"]); println!("123"); }
        "dumpsys" => { assert_eq!(&args[5..], &["meminfo","-s","123"]); println!("** MEMINFO in pid 123 [com.example.app] **\nTOTAL PSS: 2048 TOTAL RSS: 4096"); }
        "cat" if args[5] == "/proc/123/stat" => {
            let path = directory.join("counter");
            let count: u64 = fs::read_to_string(&path).unwrap_or_else(|_| "0".into()).parse().unwrap();
            fs::write(path,count.to_string()).unwrap();
            println!("{}", stat("123",100+count*10));
        }
        "cat" if args[5] == "/proc/stat" => {
            let path = directory.join("counter");
            let count: u64 = fs::read_to_string(&path).unwrap_or_else(|_| "0".into()).parse().unwrap();
            fs::write(path,(count+1).to_string()).unwrap();
            println!("cpu {} 0 0 0 0 0 0 0 100 100\ncpu0 1 0 0 0\ncpu1 1 0 0 0",1000+count*100);
        }
        _ => panic!("性能探针收到非预期参数"),
    }
}