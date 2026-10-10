use crate::support::{Case, assert_limit, fixture, framed, options};
use deviceforge_tool_process::{Error, OutputStream, ToolCommand, capture};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn argv_preserves_unicode_spaces_empty_and_shell_metacharacters() {
    let executable = fixture();
    let case = Case::new();
    let forbidden = case.path().join("SHELL_RAN");
    let values = vec![
        String::new(),
        "含空格的 中文参数".into(),
        "引号\"与末尾反斜线\\".into(),
        "& | ; < > %PATH% ${HOME} * ?".into(),
        format!("$(echo 不得执行 > '{}')", forbidden.display()),
        format!("; echo 不得执行 > \"{}\"", forbidden.display()),
    ];
    let mut args = vec!["argv".into()];
    args.extend(values.clone());
    let output = capture(
        ToolCommand::new(executable, &args),
        options(),
        CancellationToken::new(),
    )
    .await
    .expect("参数回传");
    assert_eq!(output.stdout, framed(&values));
    assert!(output.stderr.is_empty());
    assert!(!forbidden.exists(), "独立参数不得作为 shell 命令执行");
}

#[tokio::test]
async fn binary_stdin_roundtrips_including_nul_and_invalid_utf8() {
    let executable = fixture();
    let args = vec!["echo".into()];
    let input: Vec<u8> = (0..256 * 1024).map(|index| (index % 256) as u8).collect();
    let mut command = ToolCommand::new(executable, &args);
    command.input = Some(&input);
    let output = capture(command, options(), CancellationToken::new())
        .await
        .expect("二进制回传");
    assert_eq!(output.stdout, input);
    assert!(output.stderr.is_empty());
}

#[tokio::test]
async fn absent_stdin_is_closed_so_eof_reader_finishes() {
    let executable = fixture();
    let args = vec!["echo".into()];
    let output = capture(
        ToolCommand::new(executable, &args),
        options(),
        CancellationToken::new(),
    )
    .await
    .expect("关闭空输入");
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[tokio::test]
async fn concurrent_stdout_stderr_exceed_pipe_capacity_without_deadlock() {
    let executable = fixture();
    let args = vec![
        "duplex".into(),
        (384 * 1024).to_string(),
        (320 * 1024).to_string(),
    ];
    let output = capture(
        ToolCommand::new(executable, &args),
        options(),
        CancellationToken::new(),
    )
    .await
    .expect("并行读取两路管道");
    assert_eq!(output.stdout, vec![0x7f; 384 * 1024]);
    assert_eq!(output.stderr, vec![0xe1; 320 * 1024]);
}

#[tokio::test]
async fn both_streams_exactly_at_independent_limits_succeed() {
    let executable = fixture();
    let args = vec!["duplex".into(), "128".into(), "257".into()];
    let mut limits = options();
    limits.stdout_limit = 128;
    limits.stderr_limit = 257;
    let output = capture(
        ToolCommand::new(executable, &args),
        limits,
        CancellationToken::new(),
    )
    .await
    .expect("恰好等于各自限额");
    assert_eq!(output.stdout, vec![0x7f; 128]);
    assert_eq!(output.stderr, vec![0xe1; 257]);
}

#[tokio::test]
async fn stdout_one_byte_over_limit_reports_stdout() {
    let executable = fixture();
    let args = vec!["duplex".into(), "129".into(), "257".into()];
    let mut limits = options();
    limits.stdout_limit = 128;
    limits.stderr_limit = 257;
    let error = capture(
        ToolCommand::new(executable, &args),
        limits,
        CancellationToken::new(),
    )
    .await
    .expect_err("标准输出超一字节");
    assert_limit(error, OutputStream::Stdout, 128);
}

#[tokio::test]
async fn stderr_one_byte_over_limit_reports_stderr() {
    let executable = fixture();
    let args = vec!["duplex".into(), "128".into(), "258".into()];
    let mut limits = options();
    limits.stdout_limit = 128;
    limits.stderr_limit = 257;
    let error = capture(
        ToolCommand::new(executable, &args),
        limits,
        CancellationToken::new(),
    )
    .await
    .expect_err("标准错误超一字节");
    assert_limit(error, OutputStream::Stderr, 257);
}

#[tokio::test]
async fn nonzero_exit_preserves_code_and_binary_stderr() {
    let executable = fixture();
    let args = vec!["nonzero".into()];
    let error = capture(
        ToolCommand::new(executable, &args),
        options(),
        CancellationToken::new(),
    )
    .await
    .expect_err("非零退出不是成功");
    match error {
        Error::NonZeroExit { code, stderr } => {
            assert_eq!(code, Some(23));
            assert_eq!(stderr, "模拟失败\0中文\n".as_bytes());
        }
        other => panic!("非零退出错误类型不匹配：{other:?}"),
    }
}

#[tokio::test]
async fn maximum_u64_limits_do_not_overflow_for_small_outputs() {
    let executable = fixture();
    let args = vec!["duplex".into(), "128".into(), "257".into()];
    let mut limits = options();
    limits.stdout_limit = u64::MAX;
    limits.stderr_limit = u64::MAX;
    let output = capture(
        ToolCommand::new(executable, &args),
        limits,
        CancellationToken::new(),
    )
    .await
    .expect("最大限额不能加一溢出");
    assert_eq!(output.stdout, vec![0x7f; 128]);
    assert_eq!(output.stderr, vec![0xe1; 257]);
}
