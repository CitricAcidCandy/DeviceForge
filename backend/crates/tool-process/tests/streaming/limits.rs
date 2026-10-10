use crate::support::{self, Case, READY_BUDGET};
use deviceforge_tool_process::{
    Error, InputError, OutputStream, StreamOptions, ToolCommand, spawn_stream,
};
use tokio::time::{Instant, timeout};
use tokio_util::sync::CancellationToken;

#[test]
fn stream_defaults_keep_original_execution_budget_and_finite_queues() {
    let execution =
        deviceforge_tool_process::ExecutionOptions::new(Instant::now() + support::RUN_BUDGET);
    let options = StreamOptions::new(execution);
    assert_eq!(options.execution.deadline, execution.deadline);
    assert_eq!(options.execution.stdout_limit, 1024 * 1024);
    assert_eq!(options.execution.stderr_limit, 1024 * 1024);
    assert_eq!(options.chunk_size, 8192);
    assert_eq!(options.channel_capacity, 8);
    assert_eq!(options.input_limit, 1024 * 1024);
}

#[tokio::test]
async fn invalid_options_and_capture_input_are_rejected_before_spawn() {
    let executable = support::fixture();
    for invalid_case in 0..7 {
        let case = Case::new();
        let args = case.args("hold");
        let mut options = support::options();
        let mut command = ToolCommand::new(executable, &args);
        match invalid_case {
            0 => options.chunk_size = 0,
            1 => options.chunk_size = 65537,
            2 => options.channel_capacity = 0,
            3 => options.channel_capacity = 65,
            4 => options.execution.cleanup_timeout = std::time::Duration::ZERO,
            5 => options.execution.cleanup_timeout = std::time::Duration::from_secs(3),
            _ => command.input = Some(b"captured-input"),
        }
        assert!(matches!(
            spawn_stream(command, options, CancellationToken::new()).await,
            Err(Error::InvalidOptions(_))
        ));
        assert!(!case.ready().exists(), "无效配置不能启动夹具");
    }
}

#[tokio::test]
async fn input_chunk_and_total_limits_are_exact_and_shared_by_clones() {
    let executable = support::fixture();
    let case = Case::new();
    let args = case.args("echo");
    let mut options = support::options();
    options.chunk_size = 4;
    options.input_limit = 6;
    let mut process = spawn_stream(
        ToolCommand::new(executable, &args),
        options,
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let pid = support::ready(&case.ready()).await;
    let input = process.input();
    let cloned = input.clone();
    assert!(matches!(
        input.send(b"12345").await,
        Err(InputError::ChunkTooLarge { limit: 4 })
    ));
    input.send(b"1234").await.unwrap();
    assert!(matches!(
        cloned.send(b"567").await,
        Err(InputError::InputTooLarge { limit: 6 })
    ));
    cloned.send(b"56").await.unwrap();
    assert!(matches!(
        input.send(b"7").await,
        Err(InputError::InputTooLarge { limit: 6 })
    ));
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    support::receive_until(&mut process, &mut stdout, &mut stderr, 6).await;
    assert_eq!(stdout, b"123456");
    assert_eq!(stderr, stdout);
    input.close().await.unwrap();
    let exit = timeout(READY_BUDGET, process.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(exit.status.success());
    assert_eq!(exit.stdout_bytes, 11);
    assert_eq!(exit.stderr_bytes, 11);
    support::assert_exited(pid);
}

#[tokio::test]
async fn each_output_limit_reports_its_own_stream_and_confirms_direct_exit() {
    let executable = support::fixture();
    for stream in [OutputStream::Stdout, OutputStream::Stderr] {
        let case = Case::new();
        let (stdout, stderr) = match stream {
            OutputStream::Stdout => (65537, 0),
            OutputStream::Stderr => (0, 65537),
        };
        let args = case.flood_args(stdout, stderr);
        let mut options = support::options();
        options.execution.stdout_limit = 65536;
        options.execution.stderr_limit = 65536;
        options.channel_capacity = 1;
        let mut process = spawn_stream(
            ToolCommand::new(executable, &args),
            options,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let pid = support::ready(&case.ready()).await;
        case.publish_release().await;
        let error = timeout(READY_BUDGET, process.wait())
            .await
            .unwrap()
            .expect_err("超限一字节");
        match error {
            Error::OutputTooLarge {
                stream: actual,
                limit,
            } => {
                assert_eq!(actual, stream);
                assert_eq!(limit, 65536);
            }
            other => panic!("应为分路精确输出限额错误：{other:?}"),
        }
        support::assert_exited(pid);
    }
}

#[tokio::test]
async fn wait_drains_full_output_queues_and_exact_two_stream_limits() {
    let executable = support::fixture();
    let case = Case::new();
    let count = 256 * 1024;
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
    // 从未 recv；两路远超管道和单槽队列，wait 自己必须排空才能完成。
    let exit = timeout(READY_BUDGET, process.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(exit.status.success());
    assert_eq!(exit.stdout_bytes, count as u64);
    assert_eq!(exit.stderr_bytes, count as u64);
    support::assert_exited(pid);
}
