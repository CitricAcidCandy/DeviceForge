//! 自包含标准库夹具；不使用 shell，不派生后台进程，不调用平台设备工具。

use std::{
    collections::BTreeSet,
    env, fs,
    io::{self, Read, Write},
    path::Path,
    thread,
    time::Duration,
};

fn framed(values: impl IntoIterator<Item = String>) -> Vec<u8> {
    let mut bytes = Vec::new();
    for value in values {
        bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }
    bytes
}

fn ready(path: &str) {
    let path = Path::new(path);
    let temporary = path.with_extension("pending");
    fs::write(&temporary, std::process::id().to_string()).expect("写入就绪 PID");
    fs::rename(temporary, path).expect("原子发布就绪标记");
}

fn hold() {
    // 正常测试由待测库回收直接进程；两分钟保险退出不能替代及时清理断言。
    thread::sleep(Duration::from_secs(120));
}

fn stream(mut output: impl Write, count: usize, byte: u8) {
    let buffer = [byte; 8192];
    let mut left = count;
    while left > 0 {
        let length = left.min(buffer.len());
        output.write_all(&buffer[..length]).expect("写入夹具输出");
        left -= length;
    }
    output.flush().expect("刷新夹具输出");
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str).expect("提供夹具模式") {
        "argv" => io::stdout()
            .write_all(&framed(args.into_iter().skip(1)))
            .expect("回传独立参数"),
        "echo" => {
            let mut bytes = Vec::new();
            io::stdin().read_to_end(&mut bytes).expect("读取二进制输入直到 EOF");
            io::stdout().write_all(&bytes).expect("回传二进制输出");
        }
        "duplex" => {
            let stdout: usize = args[1].parse().expect("标准输出大小");
            let stderr: usize = args[2].parse().expect("标准错误大小");
            let error = thread::spawn(move || stream(io::stderr().lock(), stderr, 0xe1));
            stream(io::stdout().lock(), stdout, 0x7f);
            error.join().expect("标准错误写入线程");
        }
        "nonzero" => {
            io::stderr()
                .write_all("模拟失败\0中文\n".as_bytes())
                .expect("写入非零退出诊断");
            io::stderr().flush().expect("刷新失败诊断");
            std::process::exit(23);
        }
        "hold" => {
            ready(&args[1]);
            hold();
        }
        "release-hold" => {
            ready(&args[1]);
            let release = Path::new(&args[2]);
            let end = std::time::Instant::now() + Duration::from_secs(120);
            while !release.exists() {
                assert!(std::time::Instant::now() < end, "真实租约测试未释放夹具");
                thread::sleep(Duration::from_millis(2));
            }
            io::stdout().write_all(b"released").expect("正常退出固定输出");
        }
        "stream-hold" => {
            stream(io::stdout().lock(), 128 * 1024, 0x42);
            ready(&args[1]);
            hold();
        }
        "environment" => {
            let mut values = vec![
                env::current_dir().expect("读取工作目录").to_string_lossy().into_owned(),
                env::var("TOOL_PROCESS_TEST_EXPLICIT").unwrap_or_default(),
                env::var("PATH").unwrap_or_default(),
            ];
            // 只回传变量名称及本次公开测试值，不回传其他继承环境的内容。
            let names: BTreeSet<String> = env::vars_os()
                .map(|(key, _)| key.to_string_lossy().into_owned())
                .collect();
            values.extend(names);
            io::stdout().write_all(&framed(values)).expect("回传环境与工作目录");
        }
        _ => panic!("未知夹具模式"),
    }
}
