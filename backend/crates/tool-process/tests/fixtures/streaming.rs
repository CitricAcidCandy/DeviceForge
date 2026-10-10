//! 独立标准库流式夹具；不使用 shell，不派生后台进程，不调用平台工具。
use std::{
    env, fs,
    io::{self, Read, Write},
    path::Path,
    thread,
    time::{Duration, Instant},
};

fn publish(path: &str) {
    let path = Path::new(path);
    let pending = path.with_extension("pending");
    fs::write(&pending, std::process::id().to_string()).expect("写入完整 PID");
    fs::rename(pending, path).expect("原子发布标记");
}

fn release(path: &str) {
    let deadline = Instant::now() + Duration::from_secs(120);
    while !Path::new(path).exists() {
        assert!(Instant::now() < deadline, "用例未释放夹具");
        thread::sleep(Duration::from_millis(2));
    }
}

fn write_count(mut writer: impl Write, count: usize, byte: u8) {
    let bytes = [byte; 8192];
    let mut remaining = count;
    while remaining > 0 {
        let size = remaining.min(bytes.len());
        writer.write_all(&bytes[..size]).expect("写入原始字节");
        remaining -= size;
    }
    writer.flush().expect("刷新输出");
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let mode = args.first().expect("夹具模式").as_str();
    let ready = &args[1];
    match mode {
        "echo" => {
            publish(ready);
            let mut input = io::stdin().lock();
            let mut bytes = [0; 4096];
            loop {
                let size = input.read(&mut bytes).expect("读取持续输入");
                if size == 0 { break; }
                io::stdout().write_all(&bytes[..size]).expect("回声标准输出");
                io::stdout().flush().expect("刷新标准输出");
                io::stderr().write_all(&bytes[..size]).expect("回声标准错误");
                io::stderr().flush().expect("刷新标准错误");
            }
            io::stdout().write_all(b"EOF\0\xff").expect("输出 EOF 见证");
            io::stderr().write_all(b"END\0\xfe").expect("错误路 EOF 见证");
        }
        "release" => {
            io::stdout().write_all(b"before-exit\0\xff").expect("退出前输出");
            io::stdout().flush().expect("刷新退出前输出");
            publish(ready);
            release(&args[2]);
        }
        "exit" => {
            publish(ready);
            release(&args[2]);
            io::stdout().write_all(b"normal\0\xff").expect("正常输出");
            io::stderr().write_all(b"diagnostic\0\xfe").expect("错误路原字节");
            io::stdout().flush().expect("刷新正常输出");
            io::stderr().flush().expect("刷新错误路");
            std::process::exit(args[3].parse().expect("退出码"));
        }
        "flood" => {
            publish(ready);
            if let Some(marker) = args.get(4) { release(marker); }
            let stdout: usize = args[2].parse().expect("标准输出字节数");
            let stderr: usize = args[3].parse().expect("标准错误字节数");
            let worker = thread::spawn(move || write_count(io::stderr().lock(), stderr, 0xe1));
            write_count(io::stdout().lock(), stdout, 0x7f);
            worker.join().expect("标准错误线程完成");
        }
        "hold" => {
            publish(ready);
            // 不读取 stdin；两分钟保险退出不能代替库及时回收的证据。
            thread::sleep(Duration::from_secs(120));
        }
        _ => panic!("未知流式夹具模式"),
    }
}
