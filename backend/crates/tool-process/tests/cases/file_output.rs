use crate::support::{Case, assert_exited, assert_limit, fixture, options, ready, wait_exited};
use deviceforge_tool_process::{Error, OutputStream, ToolCommand, capture_to_file};
use std::{path::Path, time::Duration};
use tokio::{
    fs::File,
    io::AsyncWriteExt,
    time::{Instant, sleep},
};
use tokio_util::sync::CancellationToken;

async fn wait_for_bytes(path: &Path, size: u64) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if tokio::fs::metadata(path)
            .await
            .expect("读取本次输出文件")
            .len()
            >= size
        {
            return;
        }
        assert!(Instant::now() < deadline, "进程退出前没有观察到流式输出");
        sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn file_output_exact_limit_uses_file_limit_not_capture_stdout_limit() {
    let executable = fixture();
    let case = Case::new();
    let destination = case.path().join("output.bin");
    let mut file = File::create(&destination).await.expect("创建输出文件");
    let args = vec!["duplex".into(), (256 * 1024).to_string(), "257".into()];
    let mut limits = options();
    limits.stdout_limit = 1;
    limits.stderr_limit = 257;
    capture_to_file(
        ToolCommand::new(executable, &args),
        limits,
        CancellationToken::new(),
        &mut file,
        256 * 1024,
    )
    .await
    .expect("文件标准输出和标准错误恰好等于各自限额");
    drop(file);
    assert_eq!(
        tokio::fs::read(destination).await.expect("文件原字节"),
        vec![0x7f; 256 * 1024]
    );
}

#[tokio::test]
async fn file_output_one_byte_over_has_stdout_and_file_limit_error() {
    let executable = fixture();
    let case = Case::new();
    let destination = case.path().join("output.bin");
    let mut file = File::create(&destination).await.expect("创建输出文件");
    let args = vec!["duplex".into(), "129".into(), "0".into()];
    let mut limits = options();
    limits.stdout_limit = u64::MAX;
    let error = capture_to_file(
        ToolCommand::new(executable, &args),
        limits,
        CancellationToken::new(),
        &mut file,
        128,
    )
    .await
    .expect_err("文件输出超一字节");
    assert_limit(error, OutputStream::Stdout, 128);
    file.flush().await.expect("刷新可能写入的有界部分");
    assert!(
        tokio::fs::metadata(destination)
            .await
            .expect("输出元数据")
            .len()
            <= 128
    );
}

#[tokio::test]
async fn file_stderr_one_byte_over_is_independent_of_file_stdout_limit() {
    let executable = fixture();
    let case = Case::new();
    let mut file = File::create(case.path().join("output.bin"))
        .await
        .expect("创建输出文件");
    let args = vec!["duplex".into(), "128".into(), "258".into()];
    let mut limits = options();
    limits.stderr_limit = 257;
    let error = capture_to_file(
        ToolCommand::new(executable, &args),
        limits,
        CancellationToken::new(),
        &mut file,
        128,
    )
    .await
    .expect_err("文件模式标准错误超一字节");
    assert_limit(error, OutputStream::Stderr, 257);
}

#[tokio::test]
async fn file_limit_u64_max_and_binary_stdin_preserve_bytes() {
    let executable = fixture();
    let case = Case::new();
    let destination = case.path().join("output.bin");
    let mut file = File::create(&destination).await.expect("创建输出文件");
    let args = vec!["echo".into()];
    let input: Vec<u8> = (0..384 * 1024).map(|index| (index % 256) as u8).collect();
    let mut command = ToolCommand::new(executable, &args);
    command.input = Some(&input);
    capture_to_file(
        command,
        options(),
        CancellationToken::new(),
        &mut file,
        u64::MAX,
    )
    .await
    .expect("最大文件限额不溢出，二进制输入完整");
    drop(file);
    assert_eq!(
        tokio::fs::read(destination).await.expect("输出原字节"),
        input
    );
}

#[tokio::test]
async fn file_mode_nonzero_exit_retains_stderr() {
    let executable = fixture();
    let case = Case::new();
    let mut file = File::create(case.path().join("output.bin"))
        .await
        .expect("创建输出文件");
    let args = vec!["nonzero".into()];
    let error = capture_to_file(
        ToolCommand::new(executable, &args),
        options(),
        CancellationToken::new(),
        &mut file,
        4096,
    )
    .await
    .expect_err("文件模式非零退出");
    match error {
        Error::NonZeroExit { code, stderr } => {
            assert_eq!(code, Some(23));
            assert_eq!(stderr, "模拟失败\0中文\n".as_bytes());
        }
        other => panic!("错误类型不匹配：{other:?}"),
    }
}

#[tokio::test]
async fn file_is_streamed_before_exit_and_cancelled_process_is_reaped() {
    let executable = fixture();
    let case = Case::new();
    let ready_path = case.ready();
    let destination = case.path().join("output.bin");
    let mut file = File::create(&destination).await.expect("创建输出文件");
    let args = case.holding_args("stream-hold");
    let cancel = CancellationToken::new();
    let mut execution = Box::pin(capture_to_file(
        ToolCommand::new(executable, &args),
        options(),
        cancel.clone(),
        &mut file,
        256 * 1024,
    ));
    let pid = tokio::select! {
        pid = ready(&ready_path) => pid,
        result = &mut execution => panic!("流式输出夹具应保持运行：{result:?}"),
    };
    tokio::select! {
        () = wait_for_bytes(&destination, 128 * 1024) => {},
        result = &mut execution => panic!("退出前应可见文件字节：{result:?}"),
    }
    cancel.cancel();
    let error = execution.await.expect_err("流式输出后取消");
    assert!(matches!(error, Error::Cancelled));
    assert_exited(pid);
    file.flush().await.expect("刷新取消前的输出");
    drop(file);
    assert_eq!(
        tokio::fs::read(destination).await.expect("已写部分保留"),
        vec![0x42; 128 * 1024]
    );
}

#[tokio::test]
async fn file_mode_large_unread_stdin_can_be_cancelled() {
    let executable = fixture();
    let case = Case::new();
    let ready_path = case.ready();
    let mut file = File::create(case.path().join("output.bin"))
        .await
        .expect("创建输出文件");
    let args = case.holding_args("hold");
    let input = vec![0x44; 2 * 1024 * 1024];
    let mut command = ToolCommand::new(executable, &args);
    command.input = Some(&input);
    let cancel = CancellationToken::new();
    let mut execution = Box::pin(capture_to_file(
        command,
        options(),
        cancel.clone(),
        &mut file,
        4096,
    ));
    let pid = tokio::select! {
        pid = ready(&ready_path) => pid,
        result = &mut execution => panic!("应在输入阻塞期间保持运行：{result:?}"),
    };
    cancel.cancel();
    let error = execution.await.expect_err("文件模式大型输入取消");
    assert!(matches!(error, Error::Cancelled));
    assert_exited(pid);
}

#[tokio::test]
async fn dropped_file_capture_future_stops_actual_pid() {
    let executable = fixture();
    let case = Case::new();
    let ready_path = case.ready();
    let mut file = File::create(case.path().join("output.bin"))
        .await
        .expect("创建输出文件");
    let args = case.holding_args("hold");
    let mut execution = Box::pin(capture_to_file(
        ToolCommand::new(executable, &args),
        options(),
        CancellationToken::new(),
        &mut file,
        4096,
    ));
    let pid = tokio::select! {
        pid = ready(&ready_path) => pid,
        result = &mut execution => panic!("丢弃前应实际运行：{result:?}"),
    };
    drop(execution);
    wait_exited(pid).await;
}

#[tokio::test]
async fn read_only_destination_returns_file_io_error() {
    let executable = fixture();
    let case = Case::new();
    let destination = case.path().join("read-only.bin");
    tokio::fs::write(&destination, [])
        .await
        .expect("准备只读打开文件");
    let mut file = File::open(&destination).await.expect("只读文件句柄");
    let args = vec!["duplex".into(), "128".into(), "0".into()];
    let error = capture_to_file(
        ToolCommand::new(executable, &args),
        options(),
        CancellationToken::new(),
        &mut file,
        4096,
    )
    .await
    .expect_err("目标文件不可写");
    assert!(matches!(error, Error::FileIo(_)));
}

#[tokio::test]
async fn file_mode_invalid_cleanup_budgets_never_start_process() {
    let executable = fixture();
    for cleanup_timeout in [
        Duration::ZERO,
        Duration::from_secs(2) + Duration::from_nanos(1),
    ] {
        let case = Case::new();
        let args = case.holding_args("hold");
        let mut file = File::create(case.path().join("output.bin"))
            .await
            .expect("创建输出文件");
        let mut invalid = options();
        invalid.cleanup_timeout = cleanup_timeout;
        let error = capture_to_file(
            ToolCommand::new(executable, &args),
            invalid,
            CancellationToken::new(),
            &mut file,
            4096,
        )
        .await
        .expect_err("文件模式非法清理预算");
        assert!(matches!(error, Error::InvalidOptions(_)));
        assert!(!case.ready().exists());
    }
}

#[tokio::test]
async fn file_mode_precancel_and_expired_deadline_never_start_process() {
    let executable = fixture();
    for precancelled in [true, false] {
        let case = Case::new();
        let args = case.holding_args("hold");
        let mut file = File::create(case.path().join("output.bin"))
            .await
            .expect("创建输出文件");
        let cancel = CancellationToken::new();
        let limits = if precancelled {
            cancel.cancel();
            options()
        } else {
            deviceforge_tool_process::ExecutionOptions::new(Instant::now())
        };
        let error = capture_to_file(
            ToolCommand::new(executable, &args),
            limits,
            cancel,
            &mut file,
            4096,
        )
        .await
        .expect_err("文件模式预取消或到期");
        if precancelled {
            assert!(matches!(error, Error::Cancelled));
        } else {
            assert!(matches!(error, Error::Timeout));
        }
        assert!(!case.ready().exists());
    }
}
