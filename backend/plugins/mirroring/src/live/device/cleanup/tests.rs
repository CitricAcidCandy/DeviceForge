use super::*;
use deviceforge_tool_process::OutputStream;
use std::{collections::VecDeque, io};

const OWNED: &[u8] = b"demo tcp:42 localabstract:scrcpy_1234\n";
const CLEAN: &[u8] = b"DFML_CLEAN\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Directory,
    List,
    Remove,
}

struct Step {
    action: Action,
    result: Result<Vec<u8>, Error>,
    elapsed: Duration,
}

impl Step {
    fn ok(action: Action, output: &[u8]) -> Self {
        Self {
            action,
            result: Ok(output.to_vec()),
            elapsed: Duration::ZERO,
        }
    }

    fn error(action: Action, error: Error) -> Self {
        Self {
            action,
            result: Err(error),
            elapsed: Duration::ZERO,
        }
    }

    fn elapsed(mut self, elapsed: Duration) -> Self {
        self.elapsed = elapsed;
        self
    }
}

struct Fake {
    now: Instant,
    steps: VecDeque<Step>,
    calls: Vec<(Action, Instant)>,
    stop_error: Option<Error>,
    stop_elapsed: Duration,
    stops: usize,
}

impl Fake {
    fn new(steps: Vec<Step>) -> Self {
        Self {
            now: Instant::now(),
            steps: steps.into(),
            calls: Vec::new(),
            stop_error: None,
            stop_elapsed: Duration::ZERO,
            stops: 0,
        }
    }

    fn assert_consumed(&self) {
        assert!(self.steps.is_empty(), "存在未执行的预期命令");
        assert_eq!(self.stops, 1, "本地流式进程只能收口一次");
    }
}

impl Runner for Fake {
    fn now(&self) -> Instant {
        self.now
    }

    async fn stop_server(&mut self, _: &mut Option<StreamingProcess>) -> Result<(), Error> {
        self.stops += 1;
        self.now += self.stop_elapsed;
        self.stop_error.take().map_or(Ok(()), Err)
    }

    async fn command(&mut self, args: Vec<String>, deadline: Instant) -> Result<Vec<u8>, Error> {
        assert!(self.now < deadline, "截止点耗尽后不得启动命令");
        let action = match args.as_slice() {
            [shell, _] if shell == "shell" => Action::Directory,
            [forward, list] if forward == "forward" && list == "--list" => Action::List,
            [forward, remove, port]
                if forward == "forward" && remove == "--remove" && port == "tcp:42" =>
            {
                Action::Remove
            }
            _ => panic!("非预期的设备清理命令"),
        };
        let step = self.steps.pop_front().expect("命令数量超过有界计划");
        assert_eq!(action, step.action, "清理阶段顺序不符");
        self.calls.push((action, deadline));
        self.now += step.elapsed;
        step.result
    }
}

fn registered(directory: bool, forward: bool) -> Device {
    let mut device = Device::new();
    device.scid = "1234".into();
    device.directory_created = directory;
    device.server_attempted = directory;
    device.forward_attempted = forward;
    device.port = forward.then_some(42);
    device
}

fn exit(code: i32) -> Error {
    Error::NonZeroExit {
        code: Some(code),
        stderr: Vec::new(),
    }
}

fn transient() -> Error {
    Error::ProcessIo(io::Error::other("模拟一次工具管道错误"))
}

#[tokio::test]
async fn directory_transient_failure_recovers_without_repeating_confirmed_forward() {
    let mut device = registered(true, true);
    let mut runner = Fake::new(vec![
        Step::error(Action::Directory, transient()),
        Step::ok(Action::List, OWNED),
        Step::ok(Action::Remove, b""),
        Step::ok(Action::List, b""),
        Step::ok(Action::Directory, CLEAN),
    ]);
    assert!(device.cleanup_with_runner("demo", &mut runner).await);
    assert!(!device.directory_created);
    assert!(!device.server_attempted);
    assert!(!device.forward_attempted);
    assert_eq!(device.port, None);
    runner.assert_consumed();
}

#[tokio::test]
async fn forward_list_transient_failure_recovers_without_repeating_directory() {
    let mut device = registered(true, true);
    let mut runner = Fake::new(vec![
        Step::ok(Action::Directory, CLEAN),
        Step::error(Action::List, transient()),
        Step::ok(Action::List, OWNED),
        Step::ok(Action::Remove, b""),
        Step::ok(Action::List, b""),
    ]);
    assert!(device.cleanup_with_runner("demo", &mut runner).await);
    runner.assert_consumed();
}

#[tokio::test]
async fn persistent_tool_failure_stops_after_two_rounds() {
    let mut device = registered(true, true);
    let mut runner = Fake::new(vec![
        Step::error(Action::Directory, exit(1)),
        Step::error(Action::List, transient()),
        Step::error(Action::Directory, exit(1)),
        Step::error(Action::List, transient()),
    ]);
    assert!(!device.cleanup_with_runner("demo", &mut runner).await);
    assert!(device.unresolved && device.directory_created && device.forward_attempted);
    runner.assert_consumed();
}

#[tokio::test]
async fn all_remote_attempts_share_deadline_created_after_local_wait() {
    let mut device = registered(true, true);
    let mut runner = Fake::new(vec![
        Step::error(Action::Directory, exit(75)).elapsed(Duration::from_millis(100)),
        Step::error(Action::List, transient()).elapsed(Duration::from_millis(100)),
        Step::ok(Action::Directory, CLEAN).elapsed(Duration::from_millis(100)),
        Step::ok(Action::List, OWNED).elapsed(Duration::from_millis(100)),
        Step::ok(Action::Remove, b"").elapsed(Duration::from_millis(100)),
        Step::ok(Action::List, b""),
    ]);
    runner.stop_elapsed = Duration::from_secs(5);
    let expected = runner.now + runner.stop_elapsed + Duration::from_secs(2);
    assert!(device.cleanup_with_runner("demo", &mut runner).await);
    assert!(
        runner
            .calls
            .iter()
            .all(|(_, deadline)| *deadline == expected)
    );
    runner.assert_consumed();
}

#[tokio::test]
async fn exhausted_budget_starts_neither_next_stage_nor_second_round() {
    for elapsed in [Duration::from_secs(2), Duration::from_secs(4)] {
        let mut device = registered(true, true);
        let mut runner = Fake::new(vec![
            Step::error(Action::Directory, transient()).elapsed(elapsed),
        ]);
        assert!(!device.cleanup_with_runner("demo", &mut runner).await);
        assert_eq!(runner.calls.len(), 1);
        assert!(device.directory_created && device.forward_attempted);
        runner.assert_consumed();
    }
}

#[tokio::test]
async fn remove_error_is_confirmed_only_by_absence_in_same_budget() {
    for known_port in [None, Some(42)] {
        let mut device = registered(false, true);
        device.port = known_port;
        let mut runner = Fake::new(vec![
            Step::ok(Action::List, OWNED),
            Step::error(Action::Remove, exit(1)),
            Step::ok(Action::List, b""),
        ]);
        assert!(device.cleanup_with_runner("demo", &mut runner).await);
        assert_eq!(device.port, None);
        assert!(!device.forward_attempted);
        runner.assert_consumed();
    }
}

#[tokio::test]
async fn retrying_remove_requires_another_owner_lookup() {
    let mut device = registered(false, true);
    let mut runner = Fake::new(vec![
        Step::ok(Action::List, OWNED),
        Step::error(Action::Remove, exit(1)),
        Step::ok(Action::List, OWNED),
        Step::ok(Action::List, OWNED),
        Step::ok(Action::Remove, b""),
        Step::ok(Action::List, b""),
    ]);
    assert!(device.cleanup_with_runner("demo", &mut runner).await);
    runner.assert_consumed();
}

#[tokio::test]
async fn failed_post_remove_lookup_retries_lookup_not_confirmed_directory() {
    let mut device = registered(true, true);
    let mut runner = Fake::new(vec![
        Step::ok(Action::Directory, CLEAN),
        Step::ok(Action::List, OWNED),
        Step::ok(Action::Remove, b""),
        Step::error(Action::List, transient()),
        Step::ok(Action::List, b""),
    ]);
    assert!(device.cleanup_with_runner("demo", &mut runner).await);
    runner.assert_consumed();
}

#[tokio::test]
async fn foreign_reuse_after_remove_error_is_sticky_even_if_port_was_unknown() {
    for known_port in [None, Some(42)] {
        for foreign in [
            &b"other tcp:42 localabstract:scrcpy_1234\n"[..],
            &b"demo tcp:42 localabstract:foreign\n"[..],
        ] {
            let mut device = registered(false, true);
            device.port = known_port;
            let mut runner = Fake::new(vec![
                Step::ok(Action::List, OWNED),
                Step::error(Action::Remove, transient()),
                Step::ok(Action::List, foreign),
            ]);
            assert!(!device.cleanup_with_runner("demo", &mut runner).await);
            assert_eq!(device.port, Some(42));
            assert!(device.unresolved && device.forward_attempted);
            runner.assert_consumed();
        }
    }
}

#[tokio::test]
async fn ownership_is_rechecked_before_second_remove_and_conflict_blocks_it() {
    let mut device = registered(false, true);
    let mut runner = Fake::new(vec![
        Step::ok(Action::List, OWNED),
        Step::error(Action::Remove, exit(1)),
        Step::ok(Action::List, OWNED),
        Step::ok(Action::List, b"other tcp:42 localabstract:foreign\n"),
    ]);
    assert!(!device.cleanup_with_runner("demo", &mut runner).await);
    runner.assert_consumed();
}

#[tokio::test]
async fn successful_remove_followed_by_foreign_reuse_is_not_claimed_clean() {
    let mut device = registered(false, true);
    let mut runner = Fake::new(vec![
        Step::ok(Action::List, OWNED),
        Step::ok(Action::Remove, b""),
        Step::ok(Action::List, b"other tcp:42 localabstract:foreign\n"),
    ]);
    assert!(!device.cleanup_with_runner("demo", &mut runner).await);
    runner.assert_consumed();
}

#[tokio::test]
async fn unconfirmed_success_does_not_retry_delete() {
    let mut device = registered(false, true);
    let mut runner = Fake::new(vec![
        Step::ok(Action::List, OWNED),
        Step::ok(Action::Remove, b""),
        Step::ok(Action::List, OWNED),
    ]);
    assert!(!device.cleanup_with_runner("demo", &mut runner).await);
    runner.assert_consumed();
}

#[tokio::test]
async fn remove_finishing_at_deadline_cannot_start_confirmation_or_retry() {
    let mut device = registered(false, true);
    let mut runner = Fake::new(vec![
        Step::ok(Action::List, OWNED),
        Step::error(Action::Remove, exit(1)).elapsed(Duration::from_secs(2)),
    ]);
    assert!(!device.cleanup_with_runner("demo", &mut runner).await);
    assert!(device.forward_attempted);
    runner.assert_consumed();
}

#[tokio::test]
async fn direct_process_cleanup_failed_never_recovers_after_remote_success() {
    let mut device = registered(true, true);
    let mut runner = Fake::new(vec![
        Step::ok(Action::Directory, CLEAN),
        Step::ok(Action::List, OWNED),
        Step::ok(Action::Remove, b""),
        Step::ok(Action::List, b""),
    ]);
    runner.stop_error = Some(Error::CleanupFailed {
        cause: Box::new(Error::Timeout),
    });
    assert!(!device.cleanup_with_runner("demo", &mut runner).await);
    assert!(device.unresolved);
    assert!(!device.directory_created && !device.forward_attempted);
    runner.assert_consumed();
}

#[tokio::test]
async fn preexisting_unresolved_never_recovers_after_remote_success() {
    let mut device = registered(true, false);
    device.unresolved = true;
    let mut runner = Fake::new(vec![Step::ok(Action::Directory, CLEAN)]);
    assert!(!device.cleanup_with_runner("demo", &mut runner).await);
    assert!(device.unresolved);
    assert!(!device.directory_created);
    runner.assert_consumed();
}

#[tokio::test]
async fn directory_hard_errors_are_not_retried_but_forward_still_converges() {
    let hard = vec![
        exit(71),
        exit(72),
        exit(77),
        exit(78),
        Error::Timeout,
        Error::Cancelled,
        Error::CleanupFailed {
            cause: Box::new(Error::Timeout),
        },
        Error::OutputTooLarge {
            stream: OutputStream::Stdout,
            limit: OUTPUT_LIMIT as u64,
        },
    ];
    for error in hard {
        let mut device = registered(true, true);
        let mut runner = Fake::new(vec![
            Step::error(Action::Directory, error),
            Step::ok(Action::List, b""),
        ]);
        assert!(!device.cleanup_with_runner("demo", &mut runner).await);
        assert!(device.unresolved && device.directory_created && device.server_attempted);
        assert!(!device.forward_attempted);
        runner.assert_consumed();
    }
}

#[tokio::test]
async fn invalid_or_oversized_directory_marker_is_sticky() {
    for output in [
        b"DFML_CLEAN".to_vec(),
        b"unexpected\nDFML_CLEAN\n".to_vec(),
        vec![b'x'; OUTPUT_LIMIT + 1],
        vec![0xff],
    ] {
        let mut device = registered(true, false);
        let mut runner = Fake::new(vec![Step::ok(Action::Directory, &output)]);
        assert!(!device.cleanup_with_runner("demo", &mut runner).await);
        assert!(device.directory_created);
        runner.assert_consumed();
    }
}

#[tokio::test]
async fn malformed_unknown_port_list_and_conflicts_never_delete_or_retry() {
    for (port, output) in [
        (None, &b"malformed\n"[..]),
        (None, &b"demo tcp:42\n"[..]),
        (None, &b"demo tcp:42 localabstract:scrcpy_1234 extra\n"[..]),
        (None, &b"demo tcp:0 localabstract:scrcpy_1234\n"[..]),
        (None, &b"demo tcp:042 localabstract:scrcpy_1234\n"[..]),
        (None, &b"demo invalid invalid\n"[..]),
        (None, &b"\xff"[..]),
        (
            None,
            &b"demo tcp:42 localabstract:scrcpy_1234\ndemo tcp:43 localabstract:scrcpy_1234\n"[..],
        ),
        (
            None,
            &b"demo tcp:42 localabstract:scrcpy_1234\nother tcp:42 localabstract:foreign\n"[..],
        ),
        (Some(42), &b"demo tcp:42 localabstract:foreign\n"[..]),
        (Some(42), &b"other tcp:42 localabstract:scrcpy_1234\n"[..]),
        (Some(42), &b"demo tcp:43 localabstract:scrcpy_1234\n"[..]),
    ] {
        let mut device = registered(false, true);
        device.port = port;
        let mut runner = Fake::new(vec![Step::ok(Action::List, output)]);
        assert!(!device.cleanup_with_runner("demo", &mut runner).await);
        assert!(device.unresolved && device.forward_attempted);
        runner.assert_consumed();
    }
}

#[tokio::test]
async fn remove_hard_errors_or_invalid_output_cannot_be_overridden_by_later_list() {
    for error in [
        Error::CleanupFailed {
            cause: Box::new(Error::Timeout),
        },
        Error::OutputTooLarge {
            stream: OutputStream::Stderr,
            limit: OUTPUT_LIMIT as u64,
        },
        exit(72),
    ] {
        let mut device = registered(false, true);
        let mut runner = Fake::new(vec![
            Step::ok(Action::List, OWNED),
            Step::error(Action::Remove, error),
        ]);
        assert!(!device.cleanup_with_runner("demo", &mut runner).await);
        runner.assert_consumed();
    }
    let mut device = registered(false, true);
    let mut runner = Fake::new(vec![
        Step::ok(Action::List, OWNED),
        Step::ok(Action::Remove, b"unexpected"),
    ]);
    assert!(!device.cleanup_with_runner("demo", &mut runner).await);
    runner.assert_consumed();
}

#[test]
fn retry_policy_keeps_original_typed_cause() {
    let wrapped = Failure::Tool(Error::CleanupFailed {
        cause: Box::new(Error::Timeout),
    });
    assert!(!wrapped.retryable());
    assert!(matches!(
        wrapped,
        Failure::Tool(Error::CleanupFailed { cause }) if matches!(*cause, Error::Timeout)
    ));
    for code in [1, 73, 74, 75, 76] {
        assert!(Failure::Tool(exit(code)).retryable());
    }
    for code in [2, 71, 72, 77, 78, 127] {
        assert!(!Failure::Tool(exit(code)).retryable());
    }
    assert!(Failure::Tool(transient()).retryable());
    assert!(Failure::Tool(Error::Spawn(io::Error::other("模拟启动失败"))).retryable());
    assert!(!Failure::InvalidOutput.retryable());
    assert!(!Failure::OwnershipConflict.retryable());
    assert!(!Failure::NotConfirmed.retryable());
}

#[test]
fn unique_resource_names_and_private_cleanup() {
    let first = Device::new();
    let second = Device::new();
    assert_ne!(first.directory, second.directory);
    assert!(first.directory.starts_with("/data/local/tmp/deviceforge_"));
    let script = first.cleanup_script();
    assert!(script.contains(&format!("grep -Fxq scid={}", first.scid)));
    assert!(script.contains("grep -Fxq com.genymobile.scrcpy.Server"));
    assert!(script.contains("|| exit 72"));
    assert!(!script.contains("pkill"));
    assert!(!script.contains("kill-server"));
}

#[test]
fn lost_forward_reply_requires_exact_owner() {
    assert_eq!(
        cleanup_forward_port(
            b"other tcp:8 localabstract:scrcpy_1234\ndemo tcp:42 localabstract:scrcpy_1234\n",
            "demo",
            "1234",
            None
        )
        .unwrap(),
        Some(42)
    );
    assert!(
        cleanup_forward_port(
            b"demo tcp:42 localabstract:scrcpy_1234\ndemo tcp:43 localabstract:scrcpy_1234\n",
            "demo",
            "1234",
            None
        )
        .is_err()
    );
    assert_eq!(
        cleanup_forward_port(b"", "demo", "1234", None).unwrap(),
        None
    );
}

#[test]
fn reused_known_port_never_confirms_or_deletes_foreign_forward() {
    for output in [
        &b"demo tcp:42 localabstract:foreign\n"[..],
        &b"other tcp:42 localabstract:scrcpy_1234\n"[..],
        &b"demo tcp:43 localabstract:scrcpy_1234\n"[..],
    ] {
        assert!(cleanup_forward_port(output, "demo", "1234", Some(42)).is_err());
    }
    assert_eq!(
        cleanup_forward_port(OWNED, "demo", "1234", Some(42)).unwrap(),
        Some(42)
    );
    assert_eq!(
        cleanup_forward_port(
            b"other tcp:43 localabstract:foreign\n",
            "demo",
            "1234",
            Some(42)
        )
        .unwrap(),
        None
    );
    assert_eq!(
        cleanup_forward_port(b"", "demo", "1234", Some(42)).unwrap(),
        None
    );
}

#[test]
fn attempted_server_without_pid_is_never_claimed_clean() {
    let mut device = Device::new();
    assert!(!device.cleanup_script().contains("exit 77"));
    device.server_attempted = true;
    let script = device.cleanup_script();
    assert!(script.starts_with("i=0; while [ ! -f "));
    assert!(script.contains("[ $i -le 10 ] || exit 77"));
    assert!(script.find("exit 77").unwrap() < script.find("rm -rf").unwrap());
}

#[tokio::test]
async fn missing_pid_after_retry_never_infers_cleanup_from_missing_directory() {
    let mut device = registered(true, false);
    let mut runner = Fake::new(vec![
        Step::error(Action::Directory, transient()),
        Step::error(Action::Directory, exit(77)),
    ]);
    assert!(!device.cleanup_with_runner("demo", &mut runner).await);
    assert!(device.server_attempted && device.directory_created && device.unresolved);
    runner.assert_consumed();
}
