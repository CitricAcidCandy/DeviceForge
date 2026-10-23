//! 便携 Frida 启动器：仅定位同包解释器，按原始参数启动并保留退出状态。
use std::{env, process::{Command, ExitCode, Stdio}};

fn main() -> ExitCode {
    let result = (|| -> Result<i32, Box<dyn std::error::Error>> {
        let executable = env::current_exe()?;
        let root = executable.parent().ok_or("启动器缺少目录")?;
        let mode = executable.file_stem().and_then(|value| value.to_str()).ok_or("启动器名称无效")?;
        if !matches!(mode, "frida" | "frida-ps") { return Err("启动器名称无效".into()); }
        let status = Command::new(root.join("python/python.exe"))
            .arg(root.join("entry.py")).arg(mode).args(env::args_os().skip(1))
            .stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).status()?;
        Ok(status.code().unwrap_or(1))
    })();
    match result {
        Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(_) => { eprintln!("便携 Frida 启动失败，请核对闭包完整性"); ExitCode::FAILURE }
    }
}
