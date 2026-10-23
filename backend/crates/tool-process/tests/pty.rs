#![cfg(windows)]

use deviceforge_tool_process::{
    Environment, Error, ExecutionOptions, PtyProcess, PtySize, StreamOptions, ToolCommand,
    spawn_pty_with_lease,
};
use std::{future::Future, path::Path, sync::Arc, task::Poll, time::Duration};
use tokio_util::sync::CancellationToken;

// 启动Future丢弃用例须确实派出监督器，避免并发用例占满启动槽。
static LAUNCH_ORDER: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn options() -> StreamOptions {
    let mut execution =
        ExecutionOptions::new(tokio::time::Instant::now() + Duration::from_secs(15));
    execution.stdout_limit = 1024 * 1024;
    StreamOptions::new(execution)
}

async fn start(script: &str, lease: Arc<()>) -> PtyProcess {
    let _launch = LAUNCH_ORDER.lock().await;
    start_with_options(script, lease, options()).await
}

async fn start_with_options(script: &str, lease: Arc<()>, options: StreamOptions) -> PtyProcess {
    let args = vec!["-e".into(), script.into()];
    let mut command = ToolCommand::new("node", &args);
    command.environment = Environment::Restricted;
    spawn_pty_with_lease(
        command,
        options,
        PtySize::new(80, 24).unwrap(),
        CancellationToken::new(),
        lease,
    )
    .await
    .unwrap()
}

async fn until(process: &mut PtyProcess, marker: &str) -> String {
    tokio::time::timeout(Duration::from_secs(8), async {
        let mut bytes = Vec::new();
        loop {
            let chunk = process.recv().await.expect("PTY输出提前关闭");
            bytes.extend(chunk.bytes);
            let text = String::from_utf8_lossy(&bytes);
            if text.contains(marker) {
                return text.into_owned();
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn real_tty_preserves_ansi_raw_keys_unicode_resize_and_normal_exit() {
    let lease = Arc::new(());
    let mut process = start(r#"process.stdin.setRawMode(true);process.stdout.write('READY:'+process.stdin.isTTY+':'+process.stdout.isTTY+':'+process.stdout.columns+':'+process.stdout.rows+'\r\n');process.stdout.on('resize',()=>console.log('SIZE:'+process.stdout.columns+':'+process.stdout.rows));process.stdin.on('data',b=>{process.stdout.write('\x1b[31mKEY:'+b.toString('hex')+'\x1b[0m\r\n');if(b.includes(4))process.exit(0)});"#, lease.clone()).await;
    assert!(
        until(&mut process, "READY:true:true:80:24")
            .await
            .contains("READY:true:true:80:24")
    );
    process.input().send("中\u{3}".as_bytes()).await.unwrap();
    let output = until(&mut process, "KEY:e4b8ad03").await;
    assert!(output.contains("\u{1b}[31m"));
    process
        .input()
        .resize(PtySize::new(100, 40).unwrap())
        .await
        .unwrap();
    until(&mut process, "SIZE:100:40").await;
    process.input().send(&[4]).await.unwrap();
    let result = process.wait().await.unwrap();
    assert!(result.status.success());
    assert!(result.stdout_bytes > 0);
    assert_eq!(result.stderr_bytes, 0);
    assert_eq!(Arc::strong_count(&lease), 1);
}

fn exited(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            WaitForSingleObject,
        },
    };
    unsafe {
        let process = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        );
        if process.is_null() {
            return std::io::Error::last_os_error().raw_os_error() == Some(87);
        }
        let done = WaitForSingleObject(process, 0) == WAIT_OBJECT_0;
        CloseHandle(process);
        done
    }
}

async fn pids(path: &Path) -> Vec<u32> {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let Ok(bytes) = tokio::fs::read(path).await
                && let Ok(value) = serde_json::from_slice(&bytes)
            {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn cancel_reaps_root_and_descendant_when_output_is_not_consumed() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pids.json");
    let script = format!(
        r#"const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{{}},1000)'],{{stdio:'ignore'}});require('fs').writeFileSync({},JSON.stringify([process.pid,c.pid]));setInterval(()=>process.stdout.write('x'.repeat(4096)),1);"#,
        serde_json::to_string(&path.to_string_lossy()).unwrap()
    );
    let lease = Arc::new(());
    let mut process = start(&script, lease.clone()).await;
    let identities = pids(&path).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    process.cancel();
    let outcome = tokio::time::timeout(Duration::from_secs(4), process.wait())
        .await
        .unwrap();
    assert!(matches!(outcome, Err(Error::Cancelled)), "{outcome:?}");
    assert!(identities.into_iter().all(exited));
    assert_eq!(Arc::strong_count(&lease), 1);
}

#[tokio::test]
async fn absolute_deadline_reaps_tree_with_unconsumed_output_before_wait() {
    // 测试互斥排队不消耗本场景的业务期限，避免其他用例的五秒调度暂停污染预算。
    let _launch = LAUNCH_ORDER.lock().await;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pids.json");
    let script = format!(
        r#"const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{{}},1000)'],{{stdio:'ignore'}});require('fs').writeFileSync({},JSON.stringify([process.pid,c.pid]));setInterval(()=>process.stdout.write('x'.repeat(4096)),1);"#,
        serde_json::to_string(&path.to_string_lossy()).unwrap()
    );
    let mut execution = options();
    execution.execution.deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    execution.execution.stdout_limit = 16 * 1024 * 1024;
    execution.channel_capacity = 1;
    execution.chunk_size = 256;
    let deadline = execution.execution.deadline;
    let cleanup_bound = deadline + execution.execution.cleanup_timeout + Duration::from_secs(1);
    let lease = Arc::new(());
    let mut process = start_with_options(&script, lease.clone(), execution).await;
    let identities = pids(&path).await;
    assert!(tokio::time::Instant::now() < deadline);
    assert!(identities.iter().all(|pid| !exited(*pid)));

    // 不调用recv或wait，确认绝对期限能穿透满输出队列并独立完成树清理。
    tokio::time::timeout_at(cleanup_bound, async {
        while Arc::strong_count(&lease) != 1 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("未消费输出时仍须在绝对期限与清理预算内释放租约");
    assert!(tokio::time::Instant::now() >= deadline);
    assert!(identities.into_iter().all(exited));
    let outcome = process.wait().await;
    assert!(matches!(outcome, Err(Error::Timeout)), "{outcome:?}");
    assert_eq!(Arc::strong_count(&lease), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn dropping_unclaimed_start_future_reaps_already_running_tree() {
    let _launch = LAUNCH_ORDER.lock().await;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pids.json");
    let script = format!(
        r#"const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{{}},1000)'],{{stdio:'ignore'}});require('fs').writeFileSync({},JSON.stringify([process.pid,c.pid]));setInterval(()=>{{}},1000);"#,
        serde_json::to_string(&path.to_string_lossy()).unwrap()
    );
    let args = vec!["-e".into(), script];
    let mut command = ToolCommand::new("node", &args);
    command.environment = Environment::Restricted;
    let lease = Arc::new(());
    let mut opening = Box::pin(spawn_pty_with_lease(
        command,
        options(),
        PtySize::new(80, 24).unwrap(),
        CancellationToken::new(),
        lease.clone(),
    ));
    // 单线程运行时中首次轮询仅派出启动监督器，调用方不再轮询领取其结果。
    std::future::poll_fn(|context| {
        assert!(opening.as_mut().poll(context).is_pending());
        Poll::Ready(())
    })
    .await;
    let identities = pids(&path).await;
    assert!(identities.iter().all(|pid| !exited(*pid)));
    assert!(Arc::strong_count(&lease) > 1);

    // PID证据保证已运行真实原生进程，不能由“尚未启动就取消”满足断言。
    drop(opening);
    tokio::time::timeout(Duration::from_secs(4), async {
        while Arc::strong_count(&lease) != 1 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("丢弃尚未领取的启动Future必须收回已运行进程树和租约");
    assert!(identities.into_iter().all(exited));
    assert_eq!(Arc::strong_count(&lease), 1);
}

async fn interrupted_unclaimed_start_confirms_tree(deadline: bool) {
    let _launch = LAUNCH_ORDER.lock().await;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pids.json");
    let script = format!(
        r#"const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{{}},1000)'],{{stdio:'ignore'}});require('fs').writeFileSync({},JSON.stringify([process.pid,c.pid]));setInterval(()=>{{}},1000);"#,
        serde_json::to_string(&path.to_string_lossy()).unwrap()
    );
    let args = vec!["-e".into(), script];
    let mut command = ToolCommand::new("node", &args);
    command.environment = Environment::Restricted;
    let lease = Arc::new(());
    let cancel = CancellationToken::new();
    let mut execution = options();
    if deadline {
        execution.execution.deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    }
    let mut opening = Box::pin(spawn_pty_with_lease(
        command,
        execution,
        PtySize::new(80, 24).unwrap(),
        cancel.clone(),
        lease.clone(),
    ));
    // 首次轮询派出真实监督器，调用方随后保持启动Future未领取结果。
    std::future::poll_fn(|context| {
        assert!(opening.as_mut().poll(context).is_pending());
        Poll::Ready(())
    })
    .await;
    let identities = pids(&path).await;
    assert!(identities.iter().all(|pid| !exited(*pid)));
    assert!(Arc::strong_count(&lease) > 1);
    if deadline {
        assert!(tokio::time::Instant::now() < execution.execution.deadline);
        // 单线程测试刻意暂停监督任务，跨过原绝对期限后先恢复调用方轮询。
        // 以真实PID及确定的调度顺序覆盖竞态，不能由后台提前完成清理满足断言。
        std::thread::sleep(
            execution
                .execution
                .deadline
                .saturating_duration_since(tokio::time::Instant::now())
                + Duration::from_millis(5),
        );
    } else {
        cancel.cancel();
    }
    let outcome = tokio::time::timeout(
        execution.execution.cleanup_timeout + Duration::from_secs(1),
        opening,
    )
    .await
    .expect("启动中断须在清理预算内收敛")
    .err()
    .expect("已中断的启动不能返回可用终端");
    if deadline {
        assert!(matches!(outcome, Error::Timeout), "{outcome:?}");
    } else {
        assert!(matches!(outcome, Error::Cancelled), "{outcome:?}");
    }
    // 不在返回后额外等待：调用方发布终态时必须已经确认整树退出及租约释放。
    assert!(identities.into_iter().all(exited));
    assert_eq!(Arc::strong_count(&lease), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn cancelling_unclaimed_start_waits_for_running_tree_and_lease() {
    interrupted_unclaimed_start_confirms_tree(false).await;
}

#[tokio::test(flavor = "current_thread")]
async fn expired_unclaimed_start_waits_for_running_tree_and_lease() {
    interrupted_unclaimed_start_confirms_tree(true).await;
}

#[tokio::test(flavor = "current_thread")]
async fn cancelling_dispatched_start_waits_for_supervisor_before_returning() {
    let _launch = LAUNCH_ORDER.lock().await;
    let args = vec!["-e".into(), "setInterval(()=>{},1000)".into()];
    let mut command = ToolCommand::new("node", &args);
    command.environment = Environment::Restricted;
    let lease = Arc::new(());
    let cancel = CancellationToken::new();
    let mut opening = Box::pin(spawn_pty_with_lease(
        command,
        options(),
        PtySize::new(80, 24).unwrap(),
        cancel.clone(),
        lease.clone(),
    ));
    std::future::poll_fn(|context| {
        assert!(opening.as_mut().poll(context).is_pending());
        Poll::Ready(())
    })
    .await;
    // 当前线程尚未调度监督器，此时取消可稳定覆盖启动方仍持租约的分支。
    assert!(Arc::strong_count(&lease) > 1);
    cancel.cancel();
    let outcome = opening.await.err().expect("取消启动应返回错误");
    assert!(matches!(outcome, Error::Cancelled), "{outcome:?}");
    assert_eq!(Arc::strong_count(&lease), 1);
}

#[tokio::test]
async fn root_exit_reaps_surviving_descendant_and_drop_also_releases_tree() {
    for drop_session in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("pids.json");
        let script = format!(
            r#"const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{{}},1000)'],{{stdio:'ignore'}});require('fs').writeFileSync({},JSON.stringify([process.pid,c.pid]));{}"#,
            serde_json::to_string(&path.to_string_lossy()).unwrap(),
            if drop_session {
                "setInterval(()=>{},1000)"
            } else {
                "process.exit(0)"
            }
        );
        let lease = Arc::new(());
        let mut process = start(&script, lease.clone()).await;
        let identities = pids(&path).await;
        if drop_session {
            drop(process);
            tokio::time::timeout(Duration::from_secs(4), async {
                while Arc::strong_count(&lease) != 1 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        } else {
            assert!(process.wait().await.unwrap().status.success());
        }
        assert!(identities.into_iter().all(exited));
        assert_eq!(Arc::strong_count(&lease), 1);
    }
}

#[test]
fn size_boundaries_reject_invalid_dimensions() {
    assert!(PtySize::new(20, 5).is_ok());
    assert!(PtySize::new(500, 200).is_ok());
    for (cols, rows) in [(19, 24), (80, 4), (501, 24), (80, 201)] {
        assert!(PtySize::new(cols, rows).is_err());
    }
}

#[tokio::test]
async fn failed_program_start_confirms_console_and_releases_lease() {
    let _launch = LAUNCH_ORDER.lock().await;
    let lease = Arc::new(());
    let args = Vec::new();
    let command = ToolCommand::new("deviceforge-pty-test-program-does-not-exist.exe", &args);
    let result = spawn_pty_with_lease(
        command,
        options(),
        PtySize::new(80, 24).unwrap(),
        CancellationToken::new(),
        lease.clone(),
    )
    .await;
    assert!(matches!(result, Err(Error::Spawn(_))));
    assert_eq!(Arc::strong_count(&lease), 1);
}
