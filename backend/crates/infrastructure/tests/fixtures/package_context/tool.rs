// 自包含真实模拟工具；只处理本次目录、固定 argv 和本次 release 门闩。
use std::{fs, io::{self, Write}, path::PathBuf, time::{Duration, Instant}};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    assert!(args.len() >= 4, "固定工具前缀与业务 argv 必须完整");
    let mode = &args[0];
    let root = PathBuf::from(&args[1]);
    fs::write(root.join("started.pid"), std::process::id().to_string()).expect("记录本次真实启动");
    let response = &args[2];
    let request = &args[3..];
    let path = match request {
        [manifest, print, input] if manifest == "manifest" && print == "print" => {
            assert!(input.ends_with(".apk"));
            input.as_str()
        }
        [verify, verbose, certs, input] if verify == "verify" && verbose == "--verbose" && certs == "--print-certs" => {
            assert!(input.ends_with(".apk"));
            input.as_str()
        }
        [dump, manifest, input, module] if dump == "dump" && manifest == "manifest" => {
            assert!(module.starts_with("--module="));
            let input = input.strip_prefix("--bundle=").expect("固定 bundle 参数");
            assert!(input.ends_with(".aab"));
            input
        }
        _ => panic!("不接受未授权工具参数：{request:?}"),
    };
    assert!(fs::read(path).expect("真实授权副本可读").starts_with(b"PK\x03\x04"));
    fs::write(root.join("argv.txt"), request.join("\n")).expect("记录真实 argv");
    fs::write(root.join("input-path.txt"), path).expect("记录本次副本路径");
    fs::write(root.join("ready.tmp"), std::process::id().to_string()).expect("写 PID 临时标记");
    fs::rename(root.join("ready.tmp"), root.join("ready.pid")).expect("原子 ready");
    if mode == "hold" {
        let limit = Instant::now() + Duration::from_secs(60);
        while !root.join("release").exists() {
            if Instant::now() >= limit {
                eprintln!("本次测试工具安全门闩到期");
                std::process::exit(90);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    if mode == "nonzero" {
        eprintln!("独立模拟工具拒绝包体");
        fs::write(root.join("exit.code"), "7").expect("记录非零退出意图");
        std::process::exit(7);
    }
    let output = fs::read_to_string(root.join(response)).expect("独立有限响应文本")
        .replace("@INPUT@", path);
    io::stdout().write_all(output.as_bytes()).expect("真实标准输出");
    io::stdout().flush().expect("刷新响应");
    fs::write(root.join("response_written"), "1").expect("响应写入标记");
    // 标记只是意图；验收还须独立查询该 PID 是否真正结束。
    fs::write(root.join("exit.code"), "0").expect("记录零退出意图");
}
