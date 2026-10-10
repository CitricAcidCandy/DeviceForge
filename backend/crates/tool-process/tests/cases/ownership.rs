//! 租约释放点必须对应同一个已握手的真实子进程退出。

use crate::support::{self, Case, EXIT_OBSERVATION};
use deviceforge_tool_process::{
    Error, ToolCommand, capture_to_file_with_lease, capture_with_lease,
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
        // 检查发生在真正 Drop 点；不能先等待退出再掩盖提前释放。
        let exited = pid != 0 && catch_unwind(|| support::assert_exited(pid)).is_ok();
        if let Some(directory) = self.directory.take() {
            if exited {
                drop(directory);
            } else {
                // 失败时保留本次专属目录，不删除仍可能使用中的资源。
                let path = directory.keep();
                eprintln!("租约提前释放，保留 PID {pid} 的目录：{}", path.display());
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
            "已握手时租约必须仍被持有"
        );
        assert!(self.directory.is_dir(), "真实工作目录仍存在");
    }

    async fn released(self, pid: u32) {
        assert_eq!(self.pid.load(Ordering::SeqCst), pid, "观察同一个握手 PID");
        let exited = timeout(EXIT_OBSERVATION, self.dropped)
            .await
            .expect("后台所有者须在观察期限内完成租约释放")
            .expect("租约必须发送实际 Drop 证据");
        assert!(exited, "租约实际 Drop 时同一个 PID 必须已退出");
        support::assert_exited(pid);
        assert!(!self.directory.exists(), "退出后真实临时目录已释放");
    }
}

fn lease() -> (Arc<Lease>, Observation) {
    let directory = tempfile::Builder::new()
        .prefix("tool-process-lease-")
        .tempdir()
        .expect("创建本次租约工作目录");
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
async fn normal_capture_releases_lease_only_after_same_pid_exits() {
    let case = Case::new();
    let ready = case.ready();
    let release = case.path().join("release");
    let mut args = case.holding_args("release-hold");
    args.push(release.to_str().expect("受控释放标记路径").to_owned());
    let (lease, mut observation) = lease();
    let directory = observation.directory.clone();
    let mut command = ToolCommand::new(support::fixture(), &args);
    command.directory = Some(&directory);
    let execution = capture_with_lease(
        command,
        support::options(),
        CancellationToken::new(),
        lease.clone(),
    );
    drop(lease);
    let pid;
    let output = {
        tokio::pin!(execution);
        pid = tokio::select! {
            pid = support::ready(&ready) => pid,
            result = &mut execution => panic!("就绪握手前执行结束：{result:?}"),
        };
        observation.started(pid);
        tokio::fs::write(&release, b"1")
            .await
            .expect("发布正常释放标记");
        execution.await.expect("正常工具成功退出")
    };
    assert_eq!(output.stdout, b"released");
    assert!(output.stderr.is_empty());
    support::assert_exited(pid);
    observation.released(pid).await;
}

#[tokio::test]
async fn cancelled_capture_releases_lease_only_after_same_pid_exits() {
    let case = Case::new();
    let ready = case.ready();
    let args = case.holding_args("hold");
    let (lease, mut observation) = lease();
    let directory = observation.directory.clone();
    let mut command = ToolCommand::new(support::fixture(), &args);
    command.directory = Some(&directory);
    let cancel = CancellationToken::new();
    let execution = capture_with_lease(command, support::options(), cancel.clone(), lease.clone());
    drop(lease);
    let pid;
    let error = {
        tokio::pin!(execution);
        pid = tokio::select! {
            pid = support::ready(&ready) => pid,
            result = &mut execution => panic!("就绪握手前执行结束：{result:?}"),
        };
        observation.started(pid);
        cancel.cancel();
        execution.await.expect_err("取消必须失败")
    };
    assert!(matches!(error, Error::Cancelled), "精确取消错误：{error:?}");
    support::assert_exited(pid);
    observation.released(pid).await;
}

#[tokio::test]
async fn aborted_capture_transfers_lease_until_same_pid_exits() {
    let case = Case::new();
    let ready = case.ready();
    let args = case.holding_args("hold");
    let (lease, mut observation) = lease();
    let directory = observation.directory.clone();
    let execution = tokio::spawn(async move {
        let mut command = ToolCommand::new(support::fixture(), &args);
        command.directory = Some(&directory);
        capture_with_lease(command, support::options(), CancellationToken::new(), lease).await
    });
    let pid = support::ready(&ready).await;
    observation.started(pid);
    execution.abort();
    assert!(
        execution
            .await
            .expect_err("外部中止执行任务")
            .is_cancelled()
    );
    // 不先等待 PID 退出：必须由租约真正 Drop 时的同步观察证明顺序。
    observation.released(pid).await;
}

#[tokio::test]
async fn aborted_file_capture_transfers_lease_until_same_pid_exits() {
    let case = Case::new();
    let ready = case.ready();
    let args = case.holding_args("stream-hold");
    let output = case.path().join("output.bin");
    let (lease, mut observation) = lease();
    let directory = observation.directory.clone();
    let execution = tokio::spawn(async move {
        let mut file = tokio::fs::File::create(&output)
            .await
            .expect("创建受控输出文件");
        let mut command = ToolCommand::new(support::fixture(), &args);
        command.directory = Some(&directory);
        capture_to_file_with_lease(
            command,
            support::options(),
            CancellationToken::new(),
            &mut file,
            1024 * 1024,
            lease,
        )
        .await
    });
    let pid = support::ready(&ready).await;
    observation.started(pid);
    execution.abort();
    assert!(
        execution
            .await
            .expect_err("外部中止文件输出任务")
            .is_cancelled()
    );
    observation.released(pid).await;
}
