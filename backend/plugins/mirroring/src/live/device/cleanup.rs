//! 设备独占资源的两轮有界清理；安全拒绝与直接进程未确认始终保留。
use super::{Device, command_result};
use crate::{config::Config, live::model::Open};
use deviceforge_tool_process::{Error, StreamingProcess};
use std::time::Duration;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

const OUTPUT_LIMIT: usize = 8192;

/// 保留原工具错误，避免把直接进程未确认误判为其内部的暂时性原因。
#[derive(Debug)]
enum Failure {
    Tool(Error),
    InvalidOutput,
    OwnershipConflict,
    NotConfirmed,
}

impl Failure {
    fn retryable(&self) -> bool {
        match self {
            Self::Tool(Error::Spawn(_) | Error::ProcessIo(_)) => true,
            // 71/72/77 分别拒绝非法 PID、身份不符及无 PID；未知退出码也不重放。
            Self::Tool(Error::NonZeroExit {
                code: Some(code), ..
            }) => {
                matches!(code, 1 | 73..=76)
            }
            _ => false,
        }
    }
}

/// 注入命令与单调时钟，测试无需启动 ADB 或创建真实子进程。
trait Runner {
    fn now(&self) -> Instant {
        Instant::now()
    }

    async fn stop_server(&mut self, server: &mut Option<StreamingProcess>) -> Result<(), Error> {
        if let Some(server) = server.as_mut() {
            server.cancel();
            server.wait().await?;
        }
        Ok(())
    }

    async fn command(&mut self, args: Vec<String>, deadline: Instant) -> Result<Vec<u8>, Error>;
}

struct AdbRunner<'a> {
    config: &'a Config,
    device: &'a str,
    lease: Option<std::sync::Arc<crate::recovery::ledger::ToolLease>>,
}

impl Runner for AdbRunner<'_> {
    async fn command(&mut self, args: Vec<String>, deadline: Instant) -> Result<Vec<u8>, Error> {
        command_result(
            self.config,
            self.device,
            args,
            deadline,
            CancellationToken::new(),
            self.lease.clone(),
        )
        .await
    }
}

#[derive(Default)]
struct Stage {
    blocked: bool,
}

impl Stage {
    fn record(&mut self, result: &Result<(), Failure>, sticky: &mut bool) {
        if result.as_ref().is_err_and(|error| !error.retryable()) {
            self.blocked = true;
            *sticky = true;
        }
    }
}

impl Device {
    pub(crate) fn cleanup_script(&self) -> String {
        if let Some(ledger) = &self.ledger {
            return crate::recovery::remote::cleanup(&ledger.record)
                .replace("DFML_RECOVERED", "DFML_CLEAN");
        }
        // 缺 PID 不以目录缺失推断进程退出；身份无法核对时不得发送信号。
        let await_pid = if self.server_attempted {
            format!(
                "i=0; while [ ! -f {dir}/pid ]; do i=$((i+1)); [ $i -le 10 ] || exit 77; sleep 0.05; done; ",
                dir = self.directory
            )
        } else {
            String::new()
        };
        let identity = self.pid_identity_script();
        format!(
            "{await_pid}if [ -f {dir}/pid ]; then p=$(cat {dir}/pid); case $p in ''|*[!0-9]*) exit 71;; esac; if [ -e /proc/$p ]; then {identity} || exit 72; kill -TERM $p || exit 73; i=0; while kill -0 $p 2>/dev/null; do i=$((i+1)); [ $i -le 20 ] || exit 74; sleep 0.05; done; fi; fi; rm -rf {dir} || exit 75; [ ! -e {dir} ] || exit 76; echo DFML_CLEAN",
            dir = self.directory,
            identity = identity
        )
    }

    pub(crate) async fn cleanup(&mut self, config: &Config, open: &Open) -> bool {
        let mut runner = AdbRunner {
            config,
            device: &open.device_id,
            lease: self.tool_lease(),
        };
        self.cleanup_with_runner(&open.device_id, &mut runner).await
    }

    async fn cleanup_with_runner(&mut self, device: &str, runner: &mut impl Runner) -> bool {
        let mut sticky = self.unresolved;
        let stopped = runner.stop_server(&mut self.server).await;
        if stopped.is_err_and(|error| {
            matches!(
                error,
                Error::CleanupFailed { .. } | Error::OutputTooLarge { .. }
            )
        }) {
            sticky = true;
        }
        self.server = None;
        // 两秒只约束远端命令的启动与执行；工具库另行确认直接进程回收。
        // 必须在本地流式 ADB 收口后只建立一次，第二轮及后续命令均不续期。
        let deadline = runner.now() + Duration::from_secs(2);
        let mut directory = Stage::default();
        let mut forward = Stage::default();
        for _ in 0..2 {
            if runner.now() >= deadline {
                break;
            }
            if self.directory_created && !directory.blocked {
                let result = self.cleanup_directory(runner, deadline).await;
                directory.record(&result, &mut sticky);
            }
            if self.forward_attempted && !forward.blocked && runner.now() < deadline {
                let result = self.cleanup_forward(device, runner, deadline).await;
                forward.record(&result, &mut sticky);
            }
            if !self.directory_created && !self.forward_attempted {
                break;
            }
        }
        self.unresolved = sticky || self.directory_created || self.forward_attempted;
        if !self.unresolved
            && let Some(ledger) = &self.ledger
            && ledger.remove().await.is_err()
        {
            self.unresolved = true;
        }
        if !self.unresolved {
            self.ledger = None;
        }
        !self.unresolved
    }

    async fn cleanup_directory(
        &mut self,
        runner: &mut impl Runner,
        deadline: Instant,
    ) -> Result<(), Failure> {
        let output = run(
            runner,
            vec!["shell".into(), self.cleanup_script()],
            deadline,
        )
        .await?;
        if output != b"DFML_CLEAN\n" && output != b"DFML_CLEAN\r\n" {
            return Err(Failure::InvalidOutput);
        }
        self.directory_created = false;
        self.server_attempted = false;
        self.stage(
            super::journal::Resource::Directory,
            crate::recovery::Stage::Released,
        )
        .await
        .map_err(|_| Failure::NotConfirmed)?;
        self.stage(
            super::journal::Resource::Upload,
            crate::recovery::Stage::Released,
        )
        .await
        .map_err(|_| Failure::NotConfirmed)?;
        self.stage(
            super::journal::Resource::Server,
            crate::recovery::Stage::Released,
        )
        .await
        .map_err(|_| Failure::NotConfirmed)?;
        Ok(())
    }

    async fn cleanup_forward(
        &mut self,
        device: &str,
        runner: &mut impl Runner,
        deadline: Instant,
    ) -> Result<(), Failure> {
        // 每轮删除前重新查精确归属，禁止沿用上轮的映射快照。
        let Some(port) = self.owned_forward(device, runner, deadline).await? else {
            self.confirm_forward_removed().await?;
            return Ok(());
        };
        // 即使创建时的响应丢失，也固定本次已确认的端口，后查不能忽略复用。
        self.port = Some(port);
        let removed = run(
            runner,
            vec!["forward".into(), "--remove".into(), format!("tcp:{port}")],
            deadline,
        )
        .await
        .and_then(|output| {
            if output.is_empty() {
                Ok(())
            } else {
                Err(Failure::InvalidOutput)
            }
        });
        if removed.as_ref().is_err_and(|error| !error.retryable()) {
            return removed;
        }
        // remove 报暂时错误也可能已生效；同一预算内复核本次端口后才能确认。
        match self.owned_forward(device, runner, deadline).await? {
            None => {
                self.confirm_forward_removed().await?;
                Ok(())
            }
            Some(_) => match removed {
                Err(error) => Err(error),
                Ok(_) => Err(Failure::NotConfirmed),
            },
        }
    }

    async fn owned_forward(
        &self,
        device: &str,
        runner: &mut impl Runner,
        deadline: Instant,
    ) -> Result<Option<u16>, Failure> {
        let output = run(runner, vec!["forward".into(), "--list".into()], deadline).await?;
        cleanup_forward_port(&output, device, &self.scid, self.port)
    }

    async fn confirm_forward_removed(&mut self) -> Result<(), Failure> {
        self.port = None;
        self.forward_attempted = false;
        self.stage(
            super::journal::Resource::Forward,
            crate::recovery::Stage::Released,
        )
        .await
        .map_err(|_| Failure::NotConfirmed)
    }
}

async fn run(
    runner: &mut impl Runner,
    args: Vec<String>,
    deadline: Instant,
) -> Result<Vec<u8>, Failure> {
    if runner.now() >= deadline {
        return Err(Failure::Tool(Error::Timeout));
    }
    let output = runner
        .command(args, deadline)
        .await
        .map_err(Failure::Tool)?;
    if output.len() > OUTPUT_LIMIT {
        return Err(Failure::InvalidOutput);
    }
    Ok(output)
}

fn cleanup_forward_port(
    output: &[u8],
    device: &str,
    scid: &str,
    expected: Option<u16>,
) -> Result<Option<u16>, Failure> {
    if output.len() > OUTPUT_LIMIT {
        return Err(Failure::InvalidOutput);
    }
    let text = std::str::from_utf8(output).map_err(|_| Failure::InvalidOutput)?;
    let remote = format!("localabstract:scrcpy_{scid}");
    let mut owned = None;
    let mut locals = std::collections::BTreeSet::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let fields: Vec<_> = line.split_ascii_whitespace().collect();
        if fields.len() != 3
            || fields
                .iter()
                .any(|field| field.chars().any(char::is_control))
            || !valid_endpoint(fields[1])
            || !valid_endpoint(fields[2])
        {
            return Err(Failure::InvalidOutput);
        }
        if !locals.insert(fields[1]) {
            return Err(Failure::OwnershipConflict);
        }
        let port = if let Some(value) = fields[1].strip_prefix("tcp:") {
            Some(
                value
                    .parse::<u16>()
                    .ok()
                    .filter(|port| *port != 0 && value == port.to_string())
                    .ok_or(Failure::InvalidOutput)?,
            )
        } else {
            None
        };
        let matches_owner = fields[0] == device && fields[2] == remote;
        if port.is_some() && port == expected && !matches_owner {
            return Err(Failure::OwnershipConflict);
        }
        if matches_owner {
            let port = port.ok_or(Failure::InvalidOutput)?;
            if expected.is_some_and(|expected| expected != port) || owned.replace(port).is_some() {
                return Err(Failure::OwnershipConflict);
            }
        }
    }
    Ok(owned)
}

fn valid_endpoint(value: &str) -> bool {
    value.split_once(':').is_some_and(|(kind, name)| {
        !name.is_empty()
            && matches!(
                kind,
                "tcp"
                    | "localabstract"
                    | "localreserved"
                    | "localfilesystem"
                    | "dev"
                    | "dev-raw"
                    | "jdwp"
                    | "acceptfd"
                    | "vsock"
            )
    })
}

#[cfg(test)]
mod tests;
