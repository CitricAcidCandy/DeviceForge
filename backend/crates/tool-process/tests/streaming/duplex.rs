use crate::support::{self, Case, READY_BUDGET};
use deviceforge_tool_process::{InputError, OutputStream, ToolCommand, spawn_stream};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn output_is_observable_before_the_same_process_exits() {
    let executable = support::fixture();
    let case = Case::new();
    let mut args = case.args("release");
    args.push(case.release().to_str().unwrap().into());
    let mut process = spawn_stream(
        ToolCommand::new(executable, &args),
        support::options(),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let pid = support::ready(&case.ready()).await;
    let mut output = Vec::new();
    timeout(READY_BUDGET, async {
        while output.len() < b"before-exit\0\xff".len() {
            let chunk = process.recv().await.expect("退出前持续输出");
            assert_eq!(chunk.stream, OutputStream::Stdout);
            output.extend(chunk.bytes);
        }
    })
    .await
    .unwrap();
    assert_eq!(output, b"before-exit\0\xff");
    assert!(
        support::liveness::alive(pid),
        "读到输出时仍是运行中的同一 PID"
    );
    case.publish_release().await;
    let exit = timeout(READY_BUDGET, process.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(exit.status.success());
    assert_eq!(exit.stdout_bytes, output.len() as u64);
    assert_eq!(exit.stderr_bytes, 0);
    support::assert_exited(pid);
}

#[tokio::test]
async fn repeated_raw_input_echoes_both_streams_and_shared_eof_rejects_every_clone() {
    let executable = support::fixture();
    let case = Case::new();
    let args = case.args("echo");
    let mut options = support::options();
    options.chunk_size = 3;
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
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    input.send(&[0, 0xff, b'\n']).await.unwrap();
    support::receive_until(&mut process, &mut stdout, &mut stderr, 3).await;
    assert_eq!(stdout, [0, 0xff, b'\n']);
    assert_eq!(stderr, stdout);
    cloned.send(&[]).await.unwrap();
    cloned.send(&[0xfe, b'\r', 0]).await.unwrap();
    support::receive_until(&mut process, &mut stdout, &mut stderr, 6).await;
    assert!(
        support::liveness::alive(pid),
        "空输入不是 EOF，持续多次输入仍可运行"
    );
    assert_eq!(stdout, [0, 0xff, b'\n', 0xfe, b'\r', 0]);
    assert_eq!(stderr, stdout);
    cloned.close().await.unwrap();
    assert!(matches!(input.send(b"x").await, Err(InputError::Closed)));
    assert!(matches!(input.close().await, Err(InputError::Closed)));
    timeout(READY_BUDGET, async {
        while let Some(chunk) = process.recv().await {
            assert!(chunk.bytes.len() <= 3);
            match chunk.stream {
                OutputStream::Stdout => stdout.extend(chunk.bytes),
                OutputStream::Stderr => stderr.extend(chunk.bytes),
            }
        }
    })
    .await
    .unwrap();
    assert!(stdout.ends_with(b"EOF\0\xff"));
    assert!(stderr.ends_with(b"END\0\xfe"));
    let exit = process.wait().await.unwrap();
    assert!(exit.status.success());
    assert_eq!(exit.stdout_bytes, 11);
    assert_eq!(exit.stderr_bytes, 11);
    support::assert_exited(pid);
}

#[tokio::test]
async fn nonzero_exit_preserves_real_status_and_does_not_wait_for_input_eof() {
    let executable = support::fixture();
    for code in [0, 23] {
        let case = Case::new();
        let mut args = case.args("exit");
        args.push(case.release().to_str().unwrap().into());
        args.push(code.to_string());
        let mut process = spawn_stream(
            ToolCommand::new(executable, &args),
            support::options(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let pid = support::ready(&case.ready()).await;
        let input = process.input();
        case.publish_release().await;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        timeout(READY_BUDGET, async {
            while let Some(chunk) = process.recv().await {
                match chunk.stream {
                    OutputStream::Stdout => stdout.extend(chunk.bytes),
                    OutputStream::Stderr => stderr.extend(chunk.bytes),
                }
            }
        })
        .await
        .expect("进程退出必须结束流，不等持有中的输入句柄");
        let exit = timeout(READY_BUDGET, process.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(exit.status.code(), Some(code));
        assert_eq!(stdout, b"normal\0\xff");
        assert_eq!(stderr, b"diagnostic\0\xfe");
        assert_eq!(exit.stdout_bytes, stdout.len() as u64);
        assert_eq!(exit.stderr_bytes, stderr.len() as u64);
        assert!(matches!(input.send(b"late").await, Err(InputError::Closed)));
        support::assert_exited(pid);
    }
}
