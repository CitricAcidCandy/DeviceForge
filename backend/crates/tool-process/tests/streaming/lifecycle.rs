use crate::support::{self, Case, EXIT_BUDGET, READY_BUDGET};
use deviceforge_tool_process::{Error, InputError, ToolCommand, spawn_stream};
use std::{
    future::{Future, poll_fn},
    task::Poll,
    time::Duration,
};
use tokio::time::{Instant, sleep_until, timeout, timeout_at};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn precancelled_and_expired_requests_never_spawn_and_cancel_has_priority() {
    let executable = support::fixture();
    for condition in 0..3 {
        let case = Case::new();
        let args = case.args("hold");
        let cancel = CancellationToken::new();
        if condition != 1 {
            cancel.cancel();
        }
        let mut options = support::options();
        if condition != 0 {
            options.execution.deadline = Instant::now();
        }
        let result = spawn_stream(ToolCommand::new(executable, &args), options, cancel).await;
        if condition == 1 {
            assert!(
                matches!(result, Err(Error::Timeout)),
                "过期请求必须直接超时"
            );
        } else {
            assert!(matches!(result, Err(Error::Cancelled)), "预取消优先于到期");
        }
        assert!(!case.ready().exists(), "拒绝的请求不能启动夹具");
    }
}

#[tokio::test]
async fn cancellation_reaps_pid_while_output_consumer_stays_stopped() {
    let executable = support::fixture();
    let case = Case::new();
    let count = 16 * 1024 * 1024;
    let args = case.flood_args(count, count);
    let mut options = support::options();
    options.chunk_size = 1024;
    options.channel_capacity = 1;
    options.execution.stdout_limit = count as u64;
    options.execution.stderr_limit = count as u64;
    let mut process = spawn_stream(
        ToolCommand::new(executable, &args),
        options,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let pid = support::ready(&case.ready()).await;
    case.publish_release().await;
    let chunk = timeout(READY_BUDGET, process.recv())
        .await
        .unwrap()
        .expect("真实持续输出已经开始");
    assert!(!chunk.bytes.is_empty());
    assert!(support::liveness::alive(pid));
    process.cancel();
    // 停止消费后先观察直接进程退出，不能借 wait 排空队列掩盖取消死锁。
    support::wait_exited(pid).await;
    let error = timeout(READY_BUDGET, process.wait())
        .await
        .unwrap()
        .expect_err("运行取消");
    assert!(matches!(error, Error::Cancelled));
    support::assert_exited(pid);
}

#[tokio::test]
async fn original_absolute_deadline_reaps_pid_without_an_output_consumer() {
    let executable = support::fixture();
    let case = Case::new();
    let count = 16 * 1024 * 1024;
    let args = case.flood_args(count, count);
    let mut options = support::options();
    let deadline = Instant::now() + Duration::from_secs(20);
    options.execution.deadline = deadline;
    options.chunk_size = 1024;
    options.channel_capacity = 1;
    options.execution.stdout_limit = count as u64;
    options.execution.stderr_limit = count as u64;
    let mut process = spawn_stream(
        ToolCommand::new(executable, &args),
        options,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let pid = support::ready(&case.ready()).await;
    case.publish_release().await;
    let chunk = timeout_at(deadline, process.recv())
        .await
        .unwrap()
        .expect("到期前已实际输出");
    assert!(!chunk.bytes.is_empty());
    assert!(support::liveness::alive(pid));
    // 业务截止点在启动前生成；就绪及首块输出都不重新计时。
    sleep_until(deadline).await;
    support::wait_exited(pid).await;
    let error = timeout(READY_BUDGET, process.wait())
        .await
        .unwrap()
        .expect_err("停止消费仍受原截止点控制");
    assert!(matches!(error, Error::Timeout));
    assert!(Instant::now() >= deadline);
    support::assert_exited(pid);
}

#[tokio::test]
async fn blocked_input_sender_is_released_by_cancel_or_original_deadline() {
    let executable = support::fixture();
    for cancel_early in [true, false] {
        let case = Case::new();
        let args = case.args("hold");
        let mut options = support::options();
        let deadline = Instant::now() + Duration::from_secs(20);
        options.execution.deadline = deadline;
        options.chunk_size = 65536;
        options.channel_capacity = 1;
        options.input_limit = 8 * 1024 * 1024;
        let mut process = spawn_stream(
            ToolCommand::new(executable, &args),
            options,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let pid = support::ready(&case.ready()).await;
        let input = process.input();
        let mut sender = Box::pin(async move {
            let chunk = vec![0x91; 65536];
            for _ in 0..64 {
                input.send(&chunk).await?;
            }
            Ok::<(), InputError>(())
        });
        // timeout 会实际轮询发送 Future；夹具不读取 stdin，4 MiB 不能全部入队。
        assert!(
            timeout(Duration::from_millis(250), sender.as_mut())
                .await
                .is_err(),
            "发送必须实际受到背压"
        );
        assert!(
            support::liveness::alive(pid),
            "背压发生在已握手的同一个进程"
        );
        if cancel_early {
            process.cancel();
        }
        let result = timeout_at(deadline + EXIT_BUDGET, sender.as_mut())
            .await
            .expect("终止必须解除输入背压");
        assert!(matches!(result, Err(InputError::Closed)));
        let error = timeout(READY_BUDGET, process.wait())
            .await
            .unwrap()
            .expect_err("输入阻塞时终止仍生效");
        if cancel_early {
            assert!(matches!(error, Error::Cancelled));
        } else {
            assert!(matches!(error, Error::Timeout));
            assert!(Instant::now() >= deadline);
        }
        support::assert_exited(pid);
    }
}

#[tokio::test]
async fn local_cancel_does_not_cancel_parent_but_parent_cancel_reaches_stream() {
    let executable = support::fixture();
    for cancel_parent in [false, true] {
        let case = Case::new();
        let args = case.args("hold");
        let parent = CancellationToken::new();
        let mut process = spawn_stream(
            ToolCommand::new(executable, &args),
            support::options(),
            parent.clone(),
        )
        .await
        .unwrap();
        let pid = support::ready(&case.ready()).await;
        let input = process.input();
        if cancel_parent {
            parent.cancel();
        } else {
            process.cancel();
        }
        let error = timeout(READY_BUDGET, process.wait())
            .await
            .unwrap()
            .expect_err("父取消和局部取消均能终止本流");
        assert!(matches!(error, Error::Cancelled));
        assert_eq!(
            parent.is_cancelled(),
            cancel_parent,
            "局部取消不得反向取消调用者 token"
        );
        assert!(matches!(input.send(b"late").await, Err(InputError::Closed)));
        support::assert_exited(pid);
    }
}

#[tokio::test]
async fn dropping_actually_polled_wait_allows_waiting_again() {
    let executable = support::fixture();
    for cancel_after_drop in [false, true] {
        let case = Case::new();
        let mut args = case.args(if cancel_after_drop { "hold" } else { "release" });
        if !cancel_after_drop {
            args.push(case.release().to_str().unwrap().into());
        }
        let mut process = spawn_stream(
            ToolCommand::new(executable, &args),
            support::options(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let pid = support::ready(&case.ready()).await;
        let mut first_wait = Box::pin(process.wait());
        poll_fn(|context| {
            assert!(
                first_wait.as_mut().poll(context).is_pending(),
                "未释放夹具不能完成等待"
            );
            Poll::Ready(())
        })
        .await;
        assert!(
            support::liveness::alive(pid),
            "首次 wait 已轮询且同一 PID 仍活"
        );
        drop(first_wait);
        assert!(
            support::liveness::alive(pid),
            "丢弃等待 Future 不等于丢弃进程所有者"
        );
        if cancel_after_drop {
            process.cancel();
            let error = timeout(READY_BUDGET, process.wait())
                .await
                .unwrap()
                .expect_err("重新等待保留取消结果");
            assert!(matches!(error, Error::Cancelled));
        } else {
            case.publish_release().await;
            let exit = timeout(READY_BUDGET, process.wait())
                .await
                .unwrap()
                .unwrap();
            assert!(exit.status.success());
            assert_eq!(exit.stdout_bytes, b"before-exit\0\xff".len() as u64);
            assert_eq!(exit.stderr_bytes, 0);
        }
        support::assert_exited(pid);
    }
}
