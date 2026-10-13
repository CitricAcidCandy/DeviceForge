mod evidence;
mod windows;

use std::{
    fs,
    io::{Read, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn directory(root: &Path, prefix: &str) -> Result<(PathBuf, usize), String> {
    fs::create_dir_all(root).map_err(|error| error.to_string())?;
    for ordinal in 1..=64 {
        let target = root.join(format!("{prefix}-{ordinal:02}"));
        match fs::create_dir(&target) {
            Ok(()) => return Ok((target, ordinal)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("本轮调用次数超限".into())
}

fn gate(directory: &Path, name: &str) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(45) {
        match fs::read(directory.join(name)) {
            Ok(bytes) if bytes == b"1" => return Ok(()),
            Ok(_) => return Err("门闩原件内容无效".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Err("独立夹具门闩看门狗到期".into())
}

fn marker(directory: &Path, name: &str) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        if directory.join(name).is_file() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Err("派生角色尚未真实就绪".into())
}

fn child(directory: &Path, role: &str) -> Result<i32, String> {
    let children = if role == "child" {
        let mut command = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
        command
            .args([
                "--fixture-child",
                directory.to_str().ok_or("目录不是UTF-8")?,
                "grandchild",
            ])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        let descendant = command.spawn().map_err(|error| error.to_string())?;
        marker(directory, "ready-grandchild.json")?;
        vec![descendant.id()]
    } else {
        Vec::new()
    };
    let own = windows::own()?;
    let record = format!(
        "{{\"role\":{},\"identity\":{},\"children\":[{}],\"os_exit_confirmed\":false}}",
        evidence::quote(role),
        evidence::identity(&own),
        children
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",")
    );
    evidence::publish(directory, &format!("ready-{role}.json"), record.as_bytes())?;
    gate(directory, &format!("release-{role}"))?;
    Ok(0)
}

fn event(value: &str) -> Result<(), String> {
    let bytes = format!("{value}\n").into_bytes();
    let boundary = bytes
        .iter()
        .position(|byte| *byte >= 128)
        .map_or(7.min(bytes.len()), |index| index + 1);
    let mut output = std::io::stdout().lock();
    output
        .write_all(&bytes[..boundary])
        .map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())?;
    std::thread::sleep(Duration::from_millis(2));
    output
        .write_all(&bytes[boundary..])
        .map_err(|error| error.to_string())?;
    output.flush().map_err(|error| error.to_string())
}

fn version() -> Result<i32, String> {
    let root = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .ok_or("夹具入口缺少父目录")?
        .join("version-evidence");
    let (directory, _) = directory(&root, "version")?;
    evidence::publish(
        &directory,
        "ready.json",
        evidence::identity(&windows::own()?).as_bytes(),
    )?;
    gate(&directory, "release")?;
    println!("codex-cli 0.162.1");
    Ok(0)
}

fn run() -> Result<i32, String> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments == ["--version"] {
        return version();
    }
    if arguments
        .first()
        .is_some_and(|argument| argument == "--fixture-child")
    {
        if arguments.len() != 3 || !["child", "grandchild"].contains(&arguments[2].as_str()) {
            return Err("派生角色参数无效".into());
        }
        return child(Path::new(&arguments[1]), &arguments[2]);
    }
    if arguments.get(..2) != Some(&["exec".into(), "--experimental-json".into()]) {
        return Err("官方SDK固定exec参数缺失".into());
    }
    let position = arguments
        .iter()
        .position(|argument| argument == "--cd")
        .ok_or("官方SDK项目参数缺失")?;
    let project = PathBuf::from(arguments.get(position + 1).ok_or("官方SDK项目目录缺失")?);
    let (call, ordinal) = directory(&project, "call")?;
    let mode =
        fs::read_to_string(project.join("fixture-mode.txt")).map_err(|error| error.to_string())?;
    let resumed = arguments.iter().position(|argument| argument == "resume");
    let thread = match resumed {
        Some(position) => arguments.get(position + 1).ok_or("恢复线程缺失")?.clone(),
        None => fs::read_to_string(project.join(format!("thread-{ordinal:02}.txt")))
            .map_err(|error| error.to_string())?,
    };
    let mut prompt = Vec::new();
    std::io::stdin()
        .take(524289)
        .read_to_end(&mut prompt)
        .map_err(|error| error.to_string())?;
    if prompt.len() > 524288 {
        return Err("夹具提示词原字节超限".into());
    }
    evidence::publish(&call, "prompt.bin", &prompt)?;
    evidence::publish(&call, "stdin-eof", b"1")?;
    let mut descendant = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
    descendant
        .args([
            "--fixture-child",
            call.to_str().ok_or("调用目录不是UTF-8")?,
            "child",
        ])
        .creation_flags(0x0800_0000)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let child = descendant.spawn().map_err(|error| error.to_string())?;
    marker(&call, "ready-child.json")?;
    let own = windows::own()?;
    let family = windows::family(own.parent_pid)?;
    let record = format!(
        "{{\"format_version\":1,\"identity\":{},\"family\":[{}],\"children\":[{}],\"argv\":{},\"project\":{},\"thread_id\":{},\"ordinal\":{},\"host_canary_present\":{},\"host_api_key_present\":{},\"deployment_canary_present\":{}}}",
        evidence::identity(&own),
        family
            .iter()
            .map(evidence::identity)
            .collect::<Vec<_>>()
            .join(","),
        child.id(),
        evidence::array(&arguments),
        evidence::quote(&project.to_string_lossy()),
        evidence::quote(&thread),
        ordinal,
        std::env::var_os("DF_AI_SDK_HOST_CANARY").is_some(),
        std::env::var_os("OPENAI_API_KEY").is_some(),
        std::env::var("AI_SDK_TEST_CANARY")
            .is_ok_and(|value| value == "DF_AI_SDK_DEPLOYMENT_CANARY_20261012")
    );
    evidence::publish(&call, "ready.json", record.as_bytes())?;
    gate(&call, "start")?;
    event(&format!(
        "{{\"type\":\"thread.started\",\"thread_id\":{}}}",
        evidence::quote(&thread)
    ))?;
    event("{\"type\":\"turn.started\"}")?;
    if mode == "cancel" {
        gate(&call, "continue")?;
    }
    emit_items(&project, &call, ordinal)?;
    gate(&call, "continue")?;
    if mode == "missing" {
        return Ok(0);
    }
    event(
        "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"cached_input_tokens\":0,\"output_tokens\":1}}",
    )?;
    evidence::publish(
        &call,
        "provider-candidate.json",
        format!(
            "{{\"pid\":{},\"timestamp_ms\":{},\"os_exit_confirmed\":false}}",
            own.pid,
            evidence::timestamp()
        )
        .as_bytes(),
    )?;
    if mode == "late" {
        event("{\"type\":\"turn.started\"}")?;
    }
    gate(&call, "exit")?;
    Ok(if mode == "nonzero" { 7 } else { 0 })
}

fn emit_items(project: &Path, call: &Path, ordinal: usize) -> Result<(), String> {
    let canary = "DF_AI_SDK_DEPLOYMENT_CANARY_20261012";
    let reasoning = format!("公开SDK推理摘要，凭据{canary}。");
    event(&format!(
        "{{\"type\":\"item.started\",\"item\":{{\"id\":\"provider_reasoning_raw\",\"type\":\"reasoning\",\"status\":\"in_progress\",\"text\":{}}}}}",
        evidence::quote(&reasoning)
    ))?;
    event(&format!(
        "{{\"type\":\"item.completed\",\"item\":{{\"id\":\"provider_reasoning_raw\",\"type\":\"reasoning\",\"status\":\"completed\",\"text\":{}}}}}",
        evidence::quote(&reasoning)
    ))?;
    event(
        "{\"type\":\"item.started\",\"item\":{\"id\":\"provider_command_raw\",\"type\":\"command_execution\",\"status\":\"in_progress\",\"command\":\"DF_AI_SDK_PRIVATE_COMMAND\",\"aggregated_output\":\"DF_AI_SDK_PRIVATE_TOOL_OUTPUT\",\"exit_code\":null}}",
    )?;
    event(
        "{\"type\":\"item.completed\",\"item\":{\"id\":\"provider_command_raw\",\"type\":\"command_execution\",\"status\":\"completed\",\"command\":\"DF_AI_SDK_PRIVATE_COMMAND\",\"aggregated_output\":\"DF_AI_SDK_PRIVATE_TOOL_OUTPUT\",\"exit_code\":0}}",
    )?;
    event(
        "{\"type\":\"item.started\",\"item\":{\"id\":\"provider_answer_raw\",\"type\":\"agent_message\",\"status\":\"in_progress\",\"text\":\"第一段\"}}",
    )?;
    let updated = format!(
        "这是SDK完整正文快照：{}；凭据{canary}。",
        "中文🙂".repeat(1300)
    );
    event(&format!(
        "{{\"type\":\"item.updated\",\"item\":{{\"id\":\"provider_answer_raw\",\"type\":\"agent_message\",\"status\":\"in_progress\",\"text\":{}}}}}",
        evidence::quote(&updated)
    ))?;
    gate(call, "answer")?;
    let answer = fs::read_to_string(project.join(format!("answer-{ordinal:02}.txt")))
        .map_err(|error| error.to_string())?;
    event(&format!(
        "{{\"type\":\"item.completed\",\"item\":{{\"id\":\"provider_answer_raw\",\"type\":\"agent_message\",\"status\":\"completed\",\"text\":{}}}}}",
        evidence::quote(&answer)
    ))
}

fn main() {
    let code = match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("SDK原生夹具失败：{error}");
            124
        }
    };
    std::process::exit(code);
}
