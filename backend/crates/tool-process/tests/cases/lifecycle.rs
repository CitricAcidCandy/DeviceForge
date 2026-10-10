use crate::support::{Case, assert_exited, fixture, options, ready, wait_exited};
use deviceforge_tool_process::{Error, ExecutionOptions, ToolCommand, capture};
use std::time::Duration;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

#[test]
fn option_defaults_have_independent_limits_and_two_second_cleanup() {
    let deadline = Instant::now() + Duration::from_secs(60);
    let defaults = ExecutionOptions::new(deadline);
    assert_eq!(defaults.deadline, deadline);
    assert_eq!(defaults.stdout_limit, 1024 * 1024);
    assert_eq!(defaults.stderr_limit, 1024 * 1024);
    assert_eq!(defaults.cleanup_timeout, Duration::from_secs(2));
}

#[tokio::test]
async fn precancelled_request_never_starts_process() {
    let executable = fixture();
    let case = Case::new();
    let args = case.holding_args("hold");
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = capture(ToolCommand::new(executable, &args), options(), cancel)
        .await
        .expect_err("预取消");
    assert!(matches!(error, Error::Cancelled));
    assert!(!case.ready().exists(), "预取消不得启动进程");
}

#[tokio::test]
async fn expired_absolute_deadline_never_starts_process() {
    let executable = fixture();
    let case = Case::new();
    let args = case.holding_args("hold");
    let expired = ExecutionOptions::new(Instant::now());
    let error = capture(
        ToolCommand::new(executable, &args),
        expired,
        CancellationToken::new(),
    )
    .await
    .expect_err("已经到截止点");
    assert!(matches!(error, Error::Timeout));
    assert!(!case.ready().exists(), "到期请求不得重启相对期限或启动进程");
}

#[tokio::test]
async fn precancellation_takes_precedence_over_expired_deadline() {
    let executable = fixture();
    let case = Case::new();
    let args = case.holding_args("hold");
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = capture(
        ToolCommand::new(executable, &args),
        ExecutionOptions::new(Instant::now()),
        cancel,
    )
    .await
    .expect_err("取消优先于到期");
    assert!(matches!(error, Error::Cancelled));
    assert!(!case.ready().exists());
}

#[tokio::test]
async fn zero_cleanup_budget_is_invalid_before_spawn() {
    let executable = fixture();
    let case = Case::new();
    let args = case.holding_args("hold");
    let mut invalid = options();
    invalid.cleanup_timeout = Duration::ZERO;
    let error = capture(
        ToolCommand::new(executable, &args),
        invalid,
        CancellationToken::new(),
    )
    .await
    .expect_err("零清理预算");
    assert!(matches!(error, Error::InvalidOptions(_)));
    assert!(!case.ready().exists());
}

#[tokio::test]
async fn cleanup_budget_above_two_seconds_is_invalid_before_spawn() {
    let executable = fixture();
    let case = Case::new();
    let args = case.holding_args("hold");
    let mut invalid = options();
    invalid.cleanup_timeout = Duration::from_secs(2) + Duration::from_nanos(1);
    let error = capture(
        ToolCommand::new(executable, &args),
        invalid,
        CancellationToken::new(),
    )
    .await
    .expect_err("超上限清理预算");
    assert!(matches!(error, Error::InvalidOptions(_)));
    assert!(!case.ready().exists());
}

#[tokio::test]
async fn nonexistent_executable_has_spawn_error() {
    let case = Case::new();
    let missing = case.path().join("not-a-tool.exe");
    let args = vec![];
    let error = capture(
        ToolCommand::new(missing.to_str().expect("受控路径"), &args),
        options(),
        CancellationToken::new(),
    )
    .await
    .expect_err("不存在的程序");
    assert!(matches!(error, Error::Spawn(_)));
}

#[tokio::test]
async fn running_cancellation_returns_after_actual_pid_exit() {
    let executable = fixture();
    let case = Case::new();
    let args = case.holding_args("hold");
    let ready_path = case.ready();
    let cancel = CancellationToken::new();
    let mut execution = Box::pin(capture(
        ToolCommand::new(executable, &args),
        options(),
        cancel.clone(),
    ));
    let pid = tokio::select! {
        pid = ready(&ready_path) => pid,
        result = &mut execution => panic!("取消前不应完成：{result:?}"),
    };
    cancel.cancel();
    let error = execution.await.expect_err("运行取消");
    assert!(matches!(error, Error::Cancelled));
    assert_exited(pid);
}

#[tokio::test]
async fn blocked_large_stdin_is_interrupted_by_running_cancellation() {
    let executable = fixture();
    let case = Case::new();
    let args = case.holding_args("hold");
    let ready_path = case.ready();
    let input = vec![0x99; 2 * 1024 * 1024];
    let mut command = ToolCommand::new(executable, &args);
    command.input = Some(&input);
    let cancel = CancellationToken::new();
    let mut execution = Box::pin(capture(command, options(), cancel.clone()));
    let pid = tokio::select! {
        pid = ready(&ready_path) => pid,
        result = &mut execution => panic!("不读取大型输入的夹具不应提前完成：{result:?}"),
    };
    cancel.cancel();
    let error = execution.await.expect_err("写输入受阻时仍可取消");
    assert!(matches!(error, Error::Cancelled));
    assert_exited(pid);
}

#[tokio::test]
async fn absolute_deadline_covers_blocked_stdin_and_reaps_actual_pid() {
    let executable = fixture();
    let case = Case::new();
    let args = case.holding_args("hold");
    let ready_path = case.ready();
    let input = vec![0x99; 2 * 1024 * 1024];
    let mut command = ToolCommand::new(executable, &args);
    command.input = Some(&input);
    // 给真实启动留出二十秒；就绪后仍使用原截止点，不能重新计时。
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut execution = Box::pin(capture(
        command,
        ExecutionOptions::new(deadline),
        CancellationToken::new(),
    ));
    let pid = tokio::select! {
        pid = ready(&ready_path) => pid,
        result = &mut execution => panic!("夹具必须先实际启动：{result:?}"),
    };
    let error = execution.await.expect_err("大型输入阻塞也受绝对截止点控制");
    assert!(matches!(error, Error::Timeout));
    assert!(Instant::now() >= deadline);
    assert_exited(pid);
}

#[tokio::test]
async fn dropping_polled_capture_future_stops_actual_pid() {
    let executable = fixture();
    let case = Case::new();
    let args = case.holding_args("hold");
    let ready_path = case.ready();
    let mut execution = Box::pin(capture(
        ToolCommand::new(executable, &args),
        options(),
        CancellationToken::new(),
    ));
    let pid = tokio::select! {
        pid = ready(&ready_path) => pid,
        result = &mut execution => panic!("丢弃前夹具应保持运行：{result:?}"),
    };
    drop(execution);
    wait_exited(pid).await;
}

#[tokio::test]
async fn simultaneous_running_cancel_and_deadline_choose_cancel() {
    let executable = fixture();
    let case = Case::new();
    let args = case.holding_args("hold");
    let ready_path = case.ready();
    let deadline = Instant::now() + Duration::from_secs(20);
    let cancel = CancellationToken::new();
    let mut execution = Box::pin(capture(
        ToolCommand::new(executable, &args),
        ExecutionOptions::new(deadline),
        cancel.clone(),
    ));
    let pid = tokio::select! {
        pid = ready(&ready_path) => pid,
        result = &mut execution => panic!("优先级检查前必须先启动：{result:?}"),
    };
    // 暂停轮询执行 Future，让绝对截止点和取消在下一次轮询时同时就绪。
    tokio::time::sleep_until(deadline).await;
    cancel.cancel();
    let error = execution.await.expect_err("同时就绪时取消优先");
    assert!(matches!(error, Error::Cancelled));
    assert_exited(pid);
}
