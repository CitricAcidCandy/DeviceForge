//! 六业务宿主驱动的独立假工具；只在本次目录记录argv、输入及实际PID。
use std::{env, fs, io::{self, Read, Write}, path::PathBuf, process, thread, time::{Duration, Instant}};
fn main() {
    let root: PathBuf = env::current_exe().unwrap().parent().unwrap().to_owned();
    let mut index = 1;
    let call = loop {
        let path = root.join(format!("call-{index:02}"));
        match fs::create_dir(&path) {
            Ok(()) => break path,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {index += 1; assert!(index <= 64);},
            Err(error) => panic!("证据目录无法创建：{error}"),
        }
    };
    let args: Vec<String> = env::args().skip(1).collect();
    let mut bytes = Vec::new(); bytes.extend_from_slice(&(args.len() as u32).to_le_bytes());
    for arg in &args {bytes.extend_from_slice(&(arg.len() as u32).to_le_bytes()); bytes.extend_from_slice(arg.as_bytes());}
    fs::write(call.join("argv.bin"),bytes).unwrap(); fs::write(call.join("pid"),process::id().to_string()).unwrap();
    let mut input = Vec::new(); io::stdin().read_to_end(&mut input).unwrap(); fs::write(call.join("stdin.bin"),input).unwrap();
    for arg in &args {
        if let Some(target) = arg.strip_prefix("--record=") {
            // 固定字节仅满足MP4头资格，并非真实编码视频。
            fs::write(target,b"\0\0\0\x18ftypisom000000000000").unwrap();
        }
    }
    fs::write(call.join("ready.tmp"),b"1").unwrap(); fs::rename(call.join("ready.tmp"),call.join("ready")).unwrap();
    let deadline=Instant::now()+Duration::from_secs(30);
    while !root.join(format!("release-{index}")).exists() {
        assert!(Instant::now()<deadline,"失败兜底看门狗"); thread::sleep(Duration::from_millis(2));
    }
    io::stdout().write_all(&fs::read(root.join(format!("stdout-{index}"))).unwrap()).unwrap(); io::stdout().flush().unwrap();
    io::stderr().write_all(&fs::read(root.join(format!("stderr-{index}"))).unwrap()).unwrap(); io::stderr().flush().unwrap();
    let code:i32=fs::read_to_string(root.join(format!("code-{index}"))).unwrap().parse().unwrap();
    fs::write(call.join("normal-exit"),code.to_string()).unwrap(); process::exit(code);
}
