use crate::model::PROFILE;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "macos")]
mod darwin;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "macos")]
use darwin::Scope;
#[cfg(target_os = "linux")]
use linux::Scope;
#[cfg(target_os = "windows")]
use windows::Scope;

pub type OutputReader = Box<dyn Read + Send>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Launch {
    pub format_version: u32,
    pub call_id: String,
    pub nonce: String,
    pub node: PathBuf,
    pub worker: PathBuf,
    pub environment: BTreeMap<String, String>,
}

impl Launch {
    fn validate(&self) -> Result<(), String> {
        if self.format_version != 1
            || self.call_id.is_empty()
            || self.call_id.len() > 64
            || self.nonce.len() != 64
            || !self.nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !self.node.is_absolute()
            || !self.worker.is_absolute()
            || self.environment.len() > 16
            || self
                .environment
                .get("DF_SDK_PROFILE")
                .is_none_or(|profile| profile != PROFILE)
            || self.environment.keys().any(|key| {
                ![
                    "DF_SDK_PROFILE",
                    "DF_SDK_CALL_ID",
                    "DF_SDK_NONCE",
                    "DF_SDK_WORKER_PORT",
                    "DF_SDK_PROXY_PORT",
                    "DF_SDK_ROUND",
                    "DF_SDK_SDK_ENTRY",
                    "SystemRoot",
                    "TEMP",
                    "TMP",
                ]
                .contains(&key.as_str())
            })
            || self
                .environment
                .values()
                .any(|value| value.len() > 8192 || value.contains('\0'))
        {
            return Err("SDK原生监督启动资格无效".into());
        }
        if self.environment.get("DF_SDK_CALL_ID") != Some(&self.call_id)
            || self.environment.get("DF_SDK_NONCE") != Some(&self.nonce)
        {
            return Err("SDK原生监督调用归属不匹配".into());
        }
        Ok(())
    }

    pub fn command(&self) -> Command {
        let mut command = Command::new(&self.node);
        command
            .arg(&self.worker)
            .env_clear()
            .envs(&self.environment)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(directory) = self.worker.parent() {
            command.current_dir(directory);
        }
        command
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NodeExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Stop {
    kind: String,
    remaining_ms: u64,
}

fn line(reader: &mut impl Read, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let mut bytes = Vec::new();
    let mut byte = [0];
    loop {
        let count = reader.read(&mut byte).map_err(|_| "SDK原生监督输入失败")?;
        if count == 0 {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err("SDK原生监督输入帧不完整".into())
            };
        }
        if bytes.len() >= limit {
            return Err("SDK原生监督输入帧超限".into());
        }
        bytes.push(byte[0]);
        if byte[0] == b'\n' {
            return Ok(Some(bytes));
        }
    }
}

fn read_output(
    mut reader: OutputReader,
    limit: u64,
    failed: Arc<AtomicBool>,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    if reader
        .by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        failed.store(true, Ordering::Release);
        return Err("SDK原生监督管道读取失败".into());
    }
    if bytes.len() as u64 > limit {
        failed.store(true, Ordering::Release);
        return Err("SDK原生监督管道超限".into());
    }
    Ok(bytes)
}

fn emit(value: serde_json::Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| "SDK原生监督结果无效")?;
    if bytes.len() > 16_384 {
        return Err("SDK原生监督结果超限".into());
    }
    bytes.push(b'\n');
    std::io::stdout()
        .write_all(&bytes)
        .and_then(|_| std::io::stdout().flush())
        .map_err(|_| "SDK原生监督结果写入失败".into())
}

fn force_deadline(failed: bool, exited: bool, now: Instant) -> Option<Instant> {
    if failed {
        Some(now)
    } else if exited {
        Some(now + Duration::from_millis(200))
    } else {
        None
    }
}

#[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
pub fn serve() -> Result<(), String> {
    let bytes = line(&mut std::io::stdin(), 65_536)?.ok_or("SDK原生监督缺少启动帧")?;
    let launch: Launch = serde_json::from_slice(&bytes).map_err(|_| "SDK原生监督启动帧无效")?;
    launch.validate()?;
    eprintln!(
        "SDK原生监督启动 node={} worker={} sdk_entry={}",
        launch.node.display(),
        launch.worker.display(),
        launch
            .environment
            .get("DF_SDK_SDK_ENTRY")
            .map(String::as_str)
            .unwrap_or("")
    );
    let mut scope = match Scope::start(&launch) {
        Ok(scope) => scope,
        Err(error) => {
            let _ = emit(json!({
                "format_version": 1,
                "kind": "scope_error",
                "call_id": launch.call_id,
                "nonce": launch.nonce,
                "message": error,
            }));
            return Err("SDK原生监督范围启动失败".into());
        }
    };
    let pid = scope.id();
    let failed = Arc::new(AtomicBool::new(false));
    let stdout = scope.take_stdout().ok_or("SDK原生监督缺少输出管道")?;
    let stderr = scope.take_stderr().ok_or("SDK原生监督缺少诊断管道")?;
    let stdout_failure = failed.clone();
    let stderr_failure = failed.clone();
    let stdout_worker = thread::spawn(move || read_output(stdout, 8192, stdout_failure));
    let stderr_worker = thread::spawn(move || read_output(stderr, 1_048_576, stderr_failure));
    let (stop_sender, stop_receiver) = std::sync::mpsc::sync_channel(1);
    let input_failure = failed.clone();
    let input_worker = thread::spawn(move || {
        let mut reader = std::io::stdin();
        match line(&mut reader, 256) {
            Ok(Some(bytes)) => match serde_json::from_slice::<Stop>(&bytes) {
                Ok(stop)
                    if stop.kind == "stop"
                        && stop.remaining_ms > 0
                        && stop.remaining_ms <= 1000 =>
                {
                    let _ =
                        stop_sender.send(Instant::now() + Duration::from_millis(stop.remaining_ms));
                    if !matches!(line(&mut reader, 256), Ok(None)) {
                        input_failure.store(true, Ordering::Release);
                    }
                }
                _ => {
                    input_failure.store(true, Ordering::Release);
                    let _ = stop_sender.send(Instant::now() + Duration::from_millis(1000));
                }
            },
            Ok(None) => {
                let _ = stop_sender.send(Instant::now() + Duration::from_millis(1000));
            }
            Err(_) => {
                input_failure.store(true, Ordering::Release);
                let _ = stop_sender.send(Instant::now() + Duration::from_millis(1000));
            }
        }
    });
    emit(
        json!({"format_version":1,"kind":"scope_ready","call_id":launch.call_id,"nonce":launch.nonce,"process_id":pid}),
    )?;
    let mut cleanup_until = None;
    let mut force_at = None;
    let mut forced = false;
    loop {
        if let Ok(deadline) = stop_receiver.try_recv()
            && cleanup_until.is_none()
        {
            cleanup_until = Some(deadline);
            force_at = Some(Instant::now() + Duration::from_millis(200));
        }
        let exit = scope.poll()?;
        if exit.is_some() && cleanup_until.is_none() {
            cleanup_until = Some(Instant::now() + Duration::from_millis(1000));
        }
        if scope.complete()? && exit.is_some() {
            break;
        }
        if failed.load(Ordering::Acquire) || exit.is_some() {
            cleanup_until.get_or_insert(Instant::now() + Duration::from_millis(1000));
            if let Some(deadline) = force_deadline(
                failed.load(Ordering::Acquire),
                exit.is_some(),
                Instant::now(),
            ) {
                force_at.get_or_insert(deadline);
            }
        }
        if force_at.is_some_and(|deadline| Instant::now() >= deadline) && !forced {
            forced = true;
            scope.stop()?;
        }
        if cleanup_until.is_some_and(|deadline| Instant::now() >= deadline) {
            return Err("SDK原生成员退出未确认".into());
        }
        thread::sleep(Duration::from_millis(5));
    }
    let until = cleanup_until.ok_or("SDK原生清理截止点缺失")?;
    while !stdout_worker.is_finished() || !stderr_worker.is_finished() {
        if Instant::now() >= until {
            return Err("SDK原生输出worker退出未确认".into());
        }
        thread::sleep(Duration::from_millis(5));
    }
    let stdout = stdout_worker
        .join()
        .map_err(|_| "SDK原生输出worker失败")??;
    let stderr = stderr_worker
        .join()
        .map_err(|_| "SDK原生诊断worker失败")??;
    if !stderr.is_empty() {
        std::io::stderr()
            .write_all(&stderr)
            .and_then(|_| std::io::stderr().flush())
            .map_err(|_| "SDK原生诊断输出失败")?;
    }
    if !stdout.is_empty() {
        let candidate: serde_json::Value =
            serde_json::from_slice(&stdout).map_err(|_| "SDK退出候选格式无效")?;
        if candidate["call_id"] != launch.call_id
            || candidate["nonce"] != launch.nonce
            || candidate["process_id"] != pid
            || candidate["kind"] != "exit_candidate"
            || candidate["role"] != "worker"
            || candidate["format_version"] != 1
        {
            return Err("SDK退出候选身份不匹配".into());
        }
        emit(candidate)?;
    }
    emit(
        json!({"format_version":1,"kind":"scope_exit","call_id":launch.call_id,"nonce":launch.nonce,"process_id":pid,"exit":scope.poll()?,"complete":true,"forced":forced,"diagnostic_present":!stderr.is_empty(),"transport_failed":failed.load(Ordering::Acquire)}),
    )?;
    while !input_worker.is_finished() {
        if Instant::now() >= until {
            return Err("SDK原生控制worker退出未确认".into());
        }
        thread::sleep(Duration::from_millis(5));
    }
    input_worker.join().map_err(|_| "SDK原生控制worker失败")?;
    Ok(())
}

pub fn sentinel() -> Result<(), String> {
    let mut bytes = [0; 64];
    loop {
        if std::io::stdin()
            .read(&mut bytes)
            .map_err(|_| "SDK组身份管道失败")?
            == 0
        {
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_exit_keeps_a_short_accounting_window_before_force() {
        let now = Instant::now();
        let deadline = force_deadline(false, true, now).expect("正常退出应有收口窗口");
        assert!(deadline >= now + Duration::from_millis(200));
    }

    #[test]
    fn failed_transport_forces_immediately() {
        let now = Instant::now();
        assert_eq!(force_deadline(true, true, now), Some(now));
        assert_eq!(force_deadline(false, false, now), None);
    }
}
