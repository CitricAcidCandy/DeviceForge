//! 仅供 AI 任务服务验收的合成 CLI，不连接模型、不记录原始输入。
use std::{
    env, fs,
    io::{self, Read, Write},
    process, thread,
    time::{Duration, Instant},
};

fn main() {
    let root = env::current_exe()
        .expect("无法定位夹具")
        .parent()
        .expect("夹具缺少目录")
        .to_owned();
    let args: Vec<String> = env::args().skip(1).collect();
    let valid = match args.as_slice() {
        [exec, json, flag, stdin] => {
            exec == "exec" && json == "--json" && flag == "--fixture" && stdin == "-"
        }
        [exec, resume, json, id, flag, stdin] => {
            exec == "exec"
                && resume == "resume"
                && json == "--json"
                && id.len() == 36
                && id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
                && flag == "--fixture"
                && stdin == "-"
        }
        _ => false,
    };
    assert!(valid, "夹具拒绝非合成业务参数");
    let mut input = Vec::new();
    io::stdin()
        .take(1024)
        .read_to_end(&mut input)
        .expect("无法读取合成提示");
    assert!(
        input.starts_with("设备工坊合成提示/".as_bytes()) && input.len() < 256,
        "夹具只接受限定合成提示"
    );
    let mut index = 1;
    let call = loop {
        let path = root.join(format!("call-{index:02}"));
        match fs::create_dir(&path) {
            Ok(()) => break path,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                index += 1;
                assert!(index <= 64, "夹具调用次数超限");
            }
            Err(_) => panic!("无法建立调用证据目录"),
        }
    };
    // 仅持久化已校验的协议 argv、输入长度、实际 PID 与布尔环境边界。
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&(args.len() as u32).to_le_bytes());
    for arg in &args {
        bytes.extend_from_slice(&(arg.len() as u32).to_le_bytes());
        bytes.extend_from_slice(arg.as_bytes());
    }
    fs::write(call.join("argv.bin"), bytes).expect("无法记录参数");
    fs::write(call.join("pid"), process::id().to_string()).expect("无法记录进程");
    fs::write(call.join("input-bytes"), input.len().to_string()).expect("无法记录输入长度");
    fs::write(
        call.join("host-token-inherited"),
        env::var_os("APK_API_TOKEN").is_some().to_string(),
    )
    .expect("无法记录环境边界");
    fs::write(call.join("ready.tmp"), b"1").expect("无法准备门闩");
    fs::rename(call.join("ready.tmp"), call.join("ready")).expect("无法发布门闩");
    let deadline = Instant::now() + Duration::from_secs(45);
    while !root.join(format!("release-{index}")).exists() {
        assert!(Instant::now() < deadline, "合成 CLI 等待期限已到期");
        thread::sleep(Duration::from_millis(2));
    }
    let output = fs::read(root.join(format!("stdout-{index}"))).expect("缺少合成响应");
    io::stdout().write_all(&output).expect("无法输出合成事件");
    io::stdout().flush().expect("无法刷新合成事件");
    let code: i32 = fs::read_to_string(root.join(format!("code-{index}")))
        .expect("缺少退出码")
        .parse()
        .expect("退出码无效");
    fs::write(call.join("normal-exit"), code.to_string()).expect("无法记录正常退出");
    process::exit(code);
}
