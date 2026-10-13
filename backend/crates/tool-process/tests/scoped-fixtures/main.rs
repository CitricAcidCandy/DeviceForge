mod evidence;
mod options;
mod recovery;
mod windows;

use options::Options;
use std::{
    io::Write,
    os::windows::process::CommandExt,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

fn command(options: &Options, role: &str) -> Result<Command, String> {
    let mut command = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
    command.args([
        "--evidence",
        options.evidence.to_str().ok_or("证据路径不是UTF-8")?,
        "--nonce",
        &options.nonce,
        "--role",
        role,
        "--scenario",
        &options.scenario,
        "--pipe",
        if options.inherit_pipe {
            "inherit"
        } else {
            "closed"
        },
        "--delay-ms",
        &options.delay_ms.to_string(),
        "--watchdog-ms",
        &options.watchdog_ms.to_string(),
        "--parent-pid",
        &std::process::id().to_string(),
        "--root-exit-code",
        &options.root_exit_code.to_string(),
    ]);
    command.current_dir(&options.evidence).stdin(Stdio::null());
    if options.inherit_pipe {
        command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    } else {
        command.stdout(Stdio::null()).stderr(Stdio::null());
    }
    Ok(command)
}

fn spawn(options: &Options, role: &str) -> Result<Child, String> {
    command(options, role)?
        .spawn()
        .map_err(|error| format!("启动后代{role}失败：{error}"))
}

fn wait_release(options: &Options) -> Result<i32, String> {
    let started = Instant::now();
    let marker = options.evidence.join(format!("release-{}", options.role));
    while started.elapsed() < Duration::from_millis(options.watchdog_ms) {
        if marker.is_file() {
            if std::fs::read(&marker).map_err(|error| error.to_string())? != b"1" {
                return Err("门闩内容无效".into());
            }
            if options.role == "grandchild" {
                std::thread::sleep(Duration::from_millis(options.delay_ms));
            }
            let exit_code = if options.role == "root" {
                i32::from(options.root_exit_code)
            } else {
                0
            };
            evidence::publish(
                options,
                &format!("exit-intent-{}.json", options.role),
                &format!(
                    "{{\"pid\":{},\"nonce\":{},\"timestamp_ms\":{},\"planned_exit_code\":{exit_code},\"os_exit_confirmed\":false}}",
                    std::process::id(),
                    evidence::quote(&options.nonce),
                    evidence::timestamp()
                ),
            )?;
            return Ok(exit_code);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    evidence::publish(
        options,
        &format!("watchdog-{}.json", options.role),
        &format!(
            "{{\"pid\":{},\"watchdog_ms\":{},\"planned_exit_code\":124,\"os_exit_confirmed\":false}}",
            std::process::id(),
            options.watchdog_ms
        ),
    )?;
    Ok(124)
}

fn breakaway(options: &Options) -> Result<(), String> {
    let private_job_added = options.scenario == "breakaway";
    let _job = if private_job_added {
        Some(windows::deny_breakaway()?)
    } else {
        None
    };
    let ambient_job_member = windows::ambient_job_member()?;
    let mut attempted = command(options, "grandchild")?;
    attempted.creation_flags(0x0100_0000);
    let (success, code, child_pid) = match attempted.spawn() {
        Ok(mut child) => {
            let pid = child.id();
            child
                .kill()
                .map_err(|error| format!("非预期breakaway子进程回收失败：{error}"))?;
            child.wait().map_err(|error| error.to_string())?;
            (true, None, Some(pid))
        }
        Err(error) => (false, error.raw_os_error(), None),
    };
    evidence::publish(
        options,
        "breakaway.json",
        &format!(
            "{{\"schema\":1,\"explicit_job_member\":{private_job_added},\"private_job_added\":{private_job_added},\"ambient_job_member\":{ambient_job_member},\"creation_flags\":16777216,\"create_process_succeeded\":{success},\"raw_os_error\":{},\"unexpected_child_pid\":{},\"unexpected_child_reaped\":{},\"public_scope_verified\":false}}",
            code.map_or("null".into(), |value| value.to_string()),
            child_pid.map_or("null".into(), |value| value.to_string()),
            success
        ),
    )?;
    if success || code != Some(5) {
        return Err("默认禁止breakaway的明确Job未产生预期拒绝".into());
    }
    Ok(())
}

fn run() -> Result<i32, String> {
    let options = Options::parse()?;
    if options.role == "recover" {
        recovery::recover(&options)?;
        return Ok(0);
    }
    let mut children = Vec::new();
    match options.role.as_str() {
        "launcher" => children.push(spawn(&options, "root")?),
        "root" if options.scenario == "tree" => children.push(spawn(&options, "child")?),
        "child" if options.scenario == "tree" => children.push(spawn(&options, "grandchild")?),
        "root" => breakaway(&options)?,
        _ => {}
    }
    evidence::publish(
        &options,
        &format!("handles-{}.json", options.role),
        &windows::standard_handles(),
    )?;
    evidence::ready(
        &options,
        windows::own_creation()?,
        &children.iter().map(Child::id).collect::<Vec<_>>(),
    )?;
    if options.inherit_pipe {
        println!("DF_SCOPED:{}:{}", options.role, options.nonce);
        std::io::stdout()
            .flush()
            .map_err(|error| error.to_string())?;
    }
    wait_release(&options)
}

fn main() {
    let code = match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("原生夹具失败：{error}");
            2
        }
    };
    std::process::exit(code);
}
