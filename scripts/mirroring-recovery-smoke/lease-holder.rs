//! 仅在本轮夹具声明目录持有真实文件锁，绝不扫描或终止目标进程。
use std::{env, fs::{self, OpenOptions}, io, path::PathBuf, thread, time::{Duration, Instant}};

fn execute() -> io::Result<()> {
    let mut args = env::args_os().skip(1);
    assert_eq!(args.next().unwrap(), "--root");
    let root = PathBuf::from(args.next().unwrap()).canonicalize()?;
    assert!(args.next().is_none());
    assert!(root.join("fixture-owner").is_file());
    let ledger = fs::read_to_string(root.join("ledger-root"))?;
    let ledger = PathBuf::from(ledger).canonicalize()?;
    assert_eq!(ledger.file_name().unwrap(), ".mirroring-resources");
    assert!(ledger.starts_with(root.parent().unwrap()), "租约只能位于本例夹具父目录");
    let token = fs::read_to_string(root.join("token"))?;
    assert!(token.len() == 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert!(ledger.join(format!("{token}.json")).is_file(), "只允许持有实际登记资源");
    let resource = OpenOptions::new().read(true).write(true).open(ledger.join(format!("{token}.lease")))?;
    let process = OpenOptions::new().read(true).write(true).open(ledger.join("process.lock"))?;
    resource.try_lock().map_err(|error| io::Error::other(error.to_string()))?;
    process.try_lock_shared().map_err(|error| io::Error::other(error.to_string()))?;
    fs::write(root.join("ready"), std::process::id().to_string())?;
    let deadline = Instant::now() + Duration::from_secs(45);
    while !root.join("release").exists() {
        if root.join("stop-fixture").exists() || Instant::now() >= deadline {
            fs::write(root.join("forced-self-exit"), "1")?;
            std::process::exit(96);
        }
        thread::sleep(Duration::from_millis(5));
    }
    drop(resource); drop(process);
    fs::write(root.join("released"), "1")?;
    Ok(())
}

fn main() {
    if execute().is_err() { std::process::exit(93); }
}
