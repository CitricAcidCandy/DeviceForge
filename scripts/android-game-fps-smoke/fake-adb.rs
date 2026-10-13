//! 独立FPS假ADB：严格匹配冻结argv计划，原字节输出；每笔先门闩取得原OS句柄。
use std::{env, fs, io::{self, Write}, path::{Path, PathBuf}, thread, time::{Duration, Instant}};
fn slot(root: &Path, prefix: &str, maximum: u64) -> io::Result<(PathBuf, u64)> {
    for number in 1..=maximum {
        let path = root.join(format!("{prefix}-{number:03}"));
        match fs::create_dir(&path) { Ok(()) => return Ok((path, number)), Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}, Err(e) => return Err(e) }
    }
    Err(io::Error::other("固定夹具槽位超限"))
}
fn encode(args: &[String]) -> Vec<u8> {
    let mut bytes = (args.len() as u32).to_le_bytes().to_vec();
    for arg in args { bytes.extend_from_slice(&(arg.len() as u32).to_le_bytes()); bytes.extend_from_slice(arg.as_bytes()); }
    bytes
}
fn run() -> io::Result<()> {
    let root = env::current_exe()?.parent().ok_or_else(|| io::Error::other("工具须有父目录"))?.to_owned();
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() > 16 || args.iter().any(|a| a.len() > 4096) { return Err(io::Error::other("参数超限")); }
    let argv = encode(&args);
    let mode = fs::read_to_string(root.join("mode"))?;
    if mode.is_empty() || mode.len() > 48 || !mode.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') { return Err(io::Error::other("场景名称非法")); }
    let folder = root.join("inputs").join(mode.trim());
    let mut selected = None;
    for index in 1..=32 {
        let path = folder.join(format!("spec-{index:03}")); if !path.exists() { break; }
        if fs::read(path.join("argv.bin"))? == argv { if selected.is_some() { return Err(io::Error::other("固定argv重复")); } selected = Some(path); }
    }
    let spec = selected.ok_or_else(|| io::Error::other("拒绝未冻结的固定argv"))?;
    let category = fs::read_to_string(spec.join("category"))?;
    let (call, _) = slot(&root, "call", 256)?;
    fs::write(call.join("argv.bin"), argv)?; fs::write(call.join("pid"), std::process::id().to_string())?;
    fs::write(call.join("category"), category)?; fs::write(call.join("mode"), mode)?;
    let (_, ordinal) = slot(&spec, "used", 256)?;
    let mut output = None;
    for number in 1..=64 { let file = spec.join(format!("stdout-{number:03}.bin")); if !file.exists() { break; } output = Some(file); if number == ordinal { break; } }
    let bytes = fs::read(output.ok_or_else(|| io::Error::other("缺少冻结输出"))?)?;
    if bytes.len() > 1024 * 1024 { return Err(io::Error::other("固定输出超过1MiB")); }
    fs::write(call.join("ready"), "1")?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while !call.join("release").exists() {
        if Instant::now() >= deadline { return Err(io::Error::new(io::ErrorKind::TimedOut, "原OS探针门闩超时")); }
        thread::sleep(Duration::from_millis(5));
    }
    fs::write(call.join("stdout.bin"), &bytes)?; io::stdout().write_all(&bytes)?; io::stdout().flush()?;
    fs::write(call.join("completed"), "1")?; Ok(())
}
fn main() { if let Err(error) = run() { eprintln!("独立FPS夹具失败：{error}"); std::process::exit(2); } }
