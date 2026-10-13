//! 独立Root/profile假ADB：严格匹配冻结argv计划，原字节输出；先门闩取得原OS句柄。
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
fn canonical(args: &[String], root: &Path) -> io::Result<Vec<String>> {
    const PREFIX: &str = "/data/local/tmp/deviceforge-profile-";
    let mut token: Option<String> = None;
    for arg in args {
        for (position, _) in arg.match_indices(PREFIX) {
            let start = position + PREFIX.len();
            let candidate = arg.get(start..start+64).ok_or_else(|| io::Error::other("远端token长度无效"))?;
            if !candidate.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err(io::Error::other("远端token不是小写SHA256")); }
            if token.as_ref().is_some_and(|saved| saved != candidate) { return Err(io::Error::other("同命令远端token不一致")); }
            token = Some(candidate.to_owned());
        }
    }
    let Some(token) = token else { return Ok(args.to_vec()); };
    let mode = fs::read_to_string(root.join("mode"))?;
    if mode.is_empty() || mode.len()>48 || !mode.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b==b'-') { return Err(io::Error::other("token场景名称非法")); }
    let anchor = root.join("inputs").join(mode).join("remote-token");
    match fs::OpenOptions::new().write(true).create_new(true).open(&anchor) {
        Ok(mut file) => file.write_all(token.as_bytes())?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if fs::read_to_string(&anchor)? != token { return Err(io::Error::other("本轮远端token变化")); }
        },
        Err(error) => return Err(error),
    }
    Ok(args.iter().map(|value| value.replace(&token,"@TOKEN@")).collect())
}
fn run() -> io::Result<i32> {
    let root = env::current_exe()?.parent().ok_or_else(|| io::Error::other("工具须有父目录"))?.to_owned();
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() > 16 || args.iter().any(|a| a.len() > 4096) { return Err(io::Error::other("参数超限")); }
    let argv = encode(&args);
    let canonical_argv = encode(&canonical(&args,&root)?);
    let mode = fs::read_to_string(root.join("mode"))?;
    if mode.is_empty() || mode.len() > 48 || !mode.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') { return Err(io::Error::other("场景名称非法")); }
    let folder = root.join("inputs").join(mode.trim());
    let mut selected = None;
    for index in 1..=32 {
        let path = folder.join(format!("spec-{index:03}")); if !path.exists() { break; }
        if fs::read(path.join("argv.bin"))? == canonical_argv { if selected.is_some() { return Err(io::Error::other("固定argv重复")); } selected = Some(path); }
    }
    let spec = selected.ok_or_else(|| io::Error::other("拒绝未冻结的固定argv"))?;
    let category = fs::read_to_string(spec.join("category"))?;
    let (call, _) = slot(&root, "call", 256)?;
    fs::write(call.join("argv.bin"), argv)?; fs::write(call.join("pid"), std::process::id().to_string())?;
    fs::write(call.join("category"), category)?; fs::write(call.join("mode"), mode)?;
    let (_, ordinal) = slot(&spec, "used", 256)?;
    let mut output = None;
    let mut output_number = 0;
    for number in 1..=64 { let file = spec.join(format!("stdout-{number:03}.bin")); if !file.exists() { break; } output = Some(file); output_number = number; if number == ordinal { break; } }
    let bytes = fs::read(output.ok_or_else(|| io::Error::other("缺少冻结输出"))?)?;
    if bytes.len() > 1024 * 1024 { return Err(io::Error::other("固定输出超过1MiB")); }
    let status_file = spec.join(format!("exit-{output_number:03}.txt"));
    let code: i32 = if status_file.exists() { fs::read_to_string(status_file)?.parse().map_err(|_| io::Error::other("退出码不是整数"))? } else { 0 };
    if !(0..=125).contains(&code) { return Err(io::Error::other("固定退出码超限")); }
    let error_file = spec.join(format!("stderr-{output_number:03}.bin"));
    let error_bytes = if error_file.exists() { fs::read(error_file)? } else { Vec::new() };
    if error_bytes.len() > 65536 { return Err(io::Error::other("固定错误输出超过64KiB")); }
    fs::write(call.join("exit_code"), code.to_string())?;
    fs::write(call.join("ready"), "1")?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while !call.join("release").exists() {
        if Instant::now() >= deadline { return Err(io::Error::new(io::ErrorKind::TimedOut, "原OS探针门闩超时")); }
        thread::sleep(Duration::from_millis(5));
    }
    fs::write(call.join("stdout.bin"), &bytes)?; io::stdout().write_all(&bytes)?; io::stdout().flush()?;
    fs::write(call.join("stderr.bin"), &error_bytes)?; io::stderr().write_all(&error_bytes)?; io::stderr().flush()?;
    fs::write(call.join("completed"), "1")?; Ok(code)
}
fn main() { match run() { Ok(code) => std::process::exit(code), Err(error) => { eprintln!("独立profile夹具失败：{error}"); std::process::exit(126); } } }
