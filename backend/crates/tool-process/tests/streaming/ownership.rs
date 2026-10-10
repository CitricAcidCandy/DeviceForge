//! 直接进程退出与租约释放顺序必须由同一个真实 PID 的观察证明。

use crate::support::{self, Case, EXIT_BUDGET, READY_BUDGET};
use deviceforge_tool_process::{
    Error, InputError, ToolCommand, spawn_stream, spawn_stream_with_lease,
};
use std::{
    panic::catch_unwind,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
};
use tempfile::TempDir;
use tokio::{sync::oneshot, time::timeout};
use tokio_util::sync::CancellationToken;

struct Lease {
    pid: Arc<AtomicU32>,
    directory: Option<TempDir>,
    dropped: Option<oneshot::Sender<bool>>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        let pid = self.pid.load(Ordering::SeqCst);
        // 在实际 Drop 点同步检查，不能先等退出再掩盖提前释放。
        let exited = pid != 0 && catch_unwind(|| support::assert_exited(pid)).is_ok();
        if let Some(directory) = self.directory.take() {
            if exited {
                drop(directory);
            } else {
                let path = directory.keep();
                eprintln!(
                    "流式租约提前释放，保留 PID {pid} 的目录：{}",
                    path.display()
                );
            }
        }
        if let Some(sender) = self.dropped.take() {
            let _ = sender.send(exited);
        }
    }
}

struct Observation {
    pid: Arc<AtomicU32>,
    directory: PathBuf,
    dropped: oneshot::Receiver<bool>,
}

impl Observation {
    fn started(&mut self, pid: u32) {
        self.pid.store(pid, Ordering::SeqCst);
        assert!(
            matches!(
                self.dropped.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ),
            "真实握手时租约必须仍持有"
        );
        assert!(self.directory.is_dir(), "租约实际工作目录存在");
    }

    async fn released(self, pid: u32) {
        assert_eq!(
            self.pid.load(Ordering::SeqCst),
            pid,
            "始终观察同一个握手 PID"
        );
        let exited = timeout(EXIT_BUDGET, self.dropped)
            .await
            .expect("后台所有者须及时释放租约")
            .expect("租约发送实际 Drop 证据");
        assert!(exited, "租约实际 Drop 时直接 PID 必须已退出");
        support::assert_exited(pid);
        assert!(!self.directory.exists(), "进程退出后真实工作目录已释放");
    }
}

fn lease() -> (Arc<Lease>, Observation) {
    let directory = tempfile::Builder::new()
        .prefix("tool-process-stream-lease-")
        .tempdir()
        .expect("创建本次租约目录");
    let path = directory.path().to_owned();
    let pid = Arc::new(AtomicU32::new(0));
    let (sender, receiver) = oneshot::channel();
    (
        Arc::new(Lease {
            pid: pid.clone(),
            directory: Some(directory),
            dropped: Some(sender),
        }),
        Observation {
            pid,
            directory: path,
            dropped: receiver,
        },
    )
}

#[tokio::test]
async fn dropping_process_reaps_pid_even_when_input_clones_are_held() {
    let executable = support::fixture();
    let case = Case::new();
    let args = case.args("hold");
    let process = spawn_stream(
        ToolCommand::new(executable, &args),
        support::options(),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let pid = support::ready(&case.ready()).await;
    let input = process.input();
    let cloned = input.clone();
    input.send(b"queued").await.unwrap();
    drop(process);
    support::wait_exited(pid).await;
    assert!(matches!(
        timeout(READY_BUDGET, input.send(b"late")).await.unwrap(),
        Err(InputError::Closed)
    ));
    assert!(matches!(
        timeout(READY_BUDGET, cloned.close()).await.unwrap(),
        Err(InputError::Closed)
    ));
    support::assert_exited(pid);
}

#[tokio::test]
async fn normal_stream_releases_lease_only_after_same_pid_exits() {
    let executable = support::fixture();
    let case = Case::new();
    let mut args = case.args("release");
    args.push(case.release().to_str().unwrap().into());
    let (lease, mut observation) = lease();
    let directory = observation.directory.clone();
    let mut command = ToolCommand::new(executable, &args);
    command.directory = Some(&directory);
    let mut process = spawn_stream_with_lease(
        command,
        support::options(),
        CancellationToken::new(),
        lease.clone(),
    )
    .await
    .unwrap();
    drop(lease);
    let pid = support::ready(&case.ready()).await;
    observation.started(pid);
    case.publish_release().await;
    let exit = timeout(READY_BUDGET, process.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(exit.status.success());
    assert_eq!(exit.stdout_bytes, b"before-exit\0\xff".len() as u64);
    assert_eq!(exit.stderr_bytes, 0);
    observation.released(pid).await;
}

#[tokio::test]
async fn cancelled_stream_releases_lease_only_after_same_pid_exits() {
    let executable = support::fixture();
    let case = Case::new();
    let args = case.args("hold");
    let (lease, mut observation) = lease();
    let directory = observation.directory.clone();
    let mut command = ToolCommand::new(executable, &args);
    command.directory = Some(&directory);
    let mut process = spawn_stream_with_lease(
        command,
        support::options(),
        CancellationToken::new(),
        lease.clone(),
    )
    .await
    .unwrap();
    drop(lease);
    let pid = support::ready(&case.ready()).await;
    observation.started(pid);
    process.cancel();
    let error = timeout(READY_BUDGET, process.wait())
        .await
        .unwrap()
        .expect_err("取消流式进程");
    assert!(matches!(error, Error::Cancelled));
    observation.released(pid).await;
}

#[tokio::test]
async fn dropping_stream_transfers_lease_until_same_pid_exits_with_input_held() {
    let executable = support::fixture();
    let case = Case::new();
    let args = case.args("hold");
    let (lease, mut observation) = lease();
    let directory = observation.directory.clone();
    let mut command = ToolCommand::new(executable, &args);
    command.directory = Some(&directory);
    let process = spawn_stream_with_lease(
        command,
        support::options(),
        CancellationToken::new(),
        lease.clone(),
    )
    .await
    .unwrap();
    drop(lease);
    let pid = support::ready(&case.ready()).await;
    observation.started(pid);
    let input = process.input();
    drop(process);
    // 不先等 PID 退出；直接接收租约 Drop 点的同步见证。
    observation.released(pid).await;
    assert!(matches!(input.send(b"late").await, Err(InputError::Closed)));
}
