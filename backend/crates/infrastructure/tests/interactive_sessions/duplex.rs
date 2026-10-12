use crate::support::{self, BUDGET, Fixture, observe};
use apk_domain::{
    Executor,
    interactive::{SessionCleanup, SessionStream},
};
use serde_json::json;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

#[tokio::test(start_paused = true)]
async fn session_only_provider_is_explicit_and_multiple_raw_inputs_echo_before_same_pid_exits() {
    let fixture = Fixture::new();
    let provider = fixture.plugin.session_provider().unwrap();
    let definitions = provider.definitions();
    assert_eq!(definitions.len(), 1);
    assert_eq!(definitions[0].id, "plugin.independent-session.terminal");
    assert_eq!(definitions[0].protocol_version(), 5);
    assert_eq!(definitions[0].chunk_limit(), 8192);
    let mut running = fixture.launch(
        "raw-echo",
        json!({"mode":"echo-eof"}),
        Instant::now() + BUDGET,
        CancellationToken::new(),
    );
    let pid = fixture.ready(&mut running).await;
    let input = running.handle().input();
    let cloned = input.clone();
    let mut sequence = 0;
    for (index, bytes) in [vec![0, 255, 10], vec![], vec![254, 0, 13]]
        .into_iter()
        .enumerate()
    {
        observe(cloned.send(&bytes), "多次原字节输入")
            .await
            .unwrap();
        for stream in [SessionStream::Stdout, SessionStream::Stderr] {
            let chunk = observe(running.handle().recv(), "处理器退出前双路回声")
                .await
                .expect("提前输出");
            sequence += 1;
            assert_eq!(chunk.sequence, sequence);
            assert_eq!(chunk.stream, stream);
            assert_eq!(chunk.bytes, bytes);
            assert!(support::liveness::alive(pid), "读到双路输出时同一PID仍活");
        }
        let marker = fixture.event(&format!("input-{}", index + 1)).await;
        assert_eq!(marker["frame"]["bytes"], json!(bytes));
        assert!(!fixture.marker("eof").exists());
    }
    observe(input.eof(), "只发协议EOF").await.unwrap();
    assert!(observe(cloned.eof(), "重复EOF拒绝").await.is_err());
    assert!(observe(cloned.send(&[1]), "EOF后输入拒绝").await.is_err());
    let exit = running.wait().await;
    assert_eq!(exit.cleanup, SessionCleanup::Complete);
    assert!(exit.process_exited);
    assert_eq!(exit.sequence, Some(7));
    assert_eq!(
        exit.outcome.as_ref().unwrap().result,
        Some(json!({"inputs":3}))
    );
    fixture.assert_exited(pid).await;
    assert!(!fixture.plugin.has_unresolved_resources());
}

#[tokio::test(start_paused = true)]
async fn eof_retains_physical_input_and_cancel_waits_for_real_cleanup_then_zero_exit() {
    let fixture = Fixture::new();
    let mut running = fixture.launch(
        "eof-cancel",
        json!({"mode":"echo","cleanup_gate":true}),
        Instant::now() + BUDGET,
        CancellationToken::new(),
    );
    let pid = fixture.ready(&mut running).await;
    let input = running.handle().input();
    observe(input.eof(), "输入EOF").await.unwrap();
    fixture.event("eof").await;
    assert!(
        !fixture.marker("physical-eof").exists(),
        "EOF不关闭物理stdin，取消通路保持"
    );
    input.cancel();
    let control = fixture.event("cancel").await;
    assert_eq!(control["frame"]["protocol_version"], 5);
    assert_eq!(control["frame"]["session_id"], "eof-cancel");
    assert_eq!(control["frame"]["reason"], "cancelled");
    assert!(support::liveness::alive(pid));
    assert!(!fixture.marker("cleanup").exists());
    assert!(!running.supervisor.is_finished(), "真实清理前监督不能结束");
    fixture.release("release-cleanup").await;
    let exit = running.wait().await;
    assert_eq!(exit.cleanup, SessionCleanup::Complete);
    assert!(exit.process_exited);
    assert_eq!(exit.sequence, Some(1));
    assert!(
        exit.outcome
            .as_ref()
            .unwrap()
            .error
            .as_ref()
            .is_some_and(|e| !e.is_empty())
    );
    fixture.assert_exited(pid).await;
    assert!(!fixture.plugin.has_unresolved_resources());
}
