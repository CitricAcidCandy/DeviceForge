use crate::support::{self, Fixture, BUDGET, observe};
use apk_domain::{Error, Executor, interactive::{SessionCleanup, SessionRequest, SessionStream}};
use serde_json::json;
use std::{future::{Future, poll_fn}, sync::Arc, task::Poll};
use tokio::time::{Instant, advance};
use tokio_util::sync::CancellationToken;

#[tokio::test(start_paused = true)]
async fn failed_missing_mismatched_nonzero_partial_and_duplicate_finished_never_confirm_cleanup() {
    for mode in ["failed","missing","wrong-id","wrong-version","nonzero","partial","duplicate","bad-sequence"] {
        let fixture=Fixture::new();
        let mut running=fixture.launch(mode,json!({"mode":mode,"cleanup_gate":true}),Instant::now()+BUDGET,CancellationToken::new());
        let pid=fixture.ready(&mut running).await; running.handle().input().cancel(); fixture.event("cancel").await;
        fixture.release("release-cleanup").await; let exit=running.wait().await;
        assert_eq!(exit.cleanup,if mode=="failed" {SessionCleanup::Failed} else {SessionCleanup::Unconfirmed},"无效/失败终态模式：{mode}");
        assert!(exit.process_exited,"直接退出必须观测，不能仅因为协议异常猜测：{mode}");
        fixture.assert_exited(pid).await; assert!(fixture.plugin.has_unresolved_resources(),"模式{mode}必须保留外部资源风险");
        let cached=observe(running.handle().wait(),"异常终态重复等待").await; assert!(std::sync::Arc::ptr_eq(&exit,&cached));
    }
}

#[tokio::test(start_paused = true)]
async fn later_success_on_same_provider_cannot_clear_prior_unconfirmed_risk() {
    let fixture=Fixture::new();
    let provider=fixture.plugin.session_provider().unwrap();
    let mut failed=fixture.launch("sticky-first",json!({"mode":"wrong-id"}),Instant::now()+BUDGET,CancellationToken::new());
    let failed_pid=fixture.ready(&mut failed).await;
    let mut succeeding=fixture.launch("sticky-next",json!({"mode":"hold","normal_gate":true}),Instant::now()+BUDGET,CancellationToken::new());
    let success_pid=fixture.ready(&mut succeeding).await; assert_ne!(failed_pid,success_pid);
    failed.handle().input().cancel(); let failed_exit=failed.wait().await;
    assert_eq!(failed_exit.cleanup,SessionCleanup::Unconfirmed); fixture.assert_exited(failed_pid).await;
    assert!(fixture.plugin.has_unresolved_resources()); assert!(provider.has_unresolved_resources());
    fixture.release("release-normal").await; let exit=succeeding.wait().await;
    assert_eq!(exit.cleanup,SessionCleanup::Complete); assert!(exit.process_exited); assert!(exit.failure.is_none());
    fixture.assert_exited(success_pid).await; assert!(fixture.plugin.has_unresolved_resources(),"后来合法终态与零退出不能清除先前unconfirmed");
    assert!(provider.has_unresolved_resources(),"公开提供者保持同一粘性风险");
    let blocked=provider.open(SessionRequest { session_id:"sticky-blocked".into(), operation:"plugin.independent-session.terminal".into(),
        input:json!({"mode":"hold"}), deadline:(Instant::now()+BUDGET).into_std() },CancellationToken::new());
    assert!(matches!(blocked,Err(Error::CleanupFailed)),"已有未确认风险必须拒绝第三次准入");
}

#[tokio::test(start_paused = true)]
async fn input_chunk_boundary_and_shared_eof_reject_before_wire_admission() {
    let fixture=Fixture::new();
    let mut running=fixture.launch("input-admission",json!({"mode":"echo","cleanup_gate":true}),Instant::now()+BUDGET,CancellationToken::new());
    let pid=fixture.ready(&mut running).await; let input=running.handle().input(); let cloned=input.clone();
    assert!(observe(input.send(&vec![1;8193]),"超过单块上限拒绝").await.is_err());
    assert!(!fixture.marker("input-1").exists(),"拒绝块不得发送到插件");
    observe(input.send(&vec![255;8192]),"恰好单块限额").await.unwrap();
    for _ in 0..2 { let chunk=observe(running.handle().recv(),"边界原字节回声").await.unwrap(); assert_eq!(chunk.bytes,vec![255;8192]); }
    observe(cloned.eof(),"clone共享EOF准入").await.unwrap(); fixture.event("eof").await;
    assert!(observe(input.eof(),"原句柄重复EOF拒绝").await.is_err()); assert!(observe(input.send(&[]),"EOF后空块也拒绝").await.is_err());
    assert!(!fixture.marker("input-2").exists()); input.cancel(); fixture.event("cancel").await;
    fixture.release("release-cleanup").await; let exit=running.wait().await; assert_eq!(exit.cleanup,SessionCleanup::Complete); fixture.assert_exited(pid).await;
}

#[tokio::test(start_paused = true)]
async fn input_pending_without_polling_supervisor_closes_on_cancel_or_deadline() {
    for expire in [false,true] {
        let fixture=Fixture::new();
        let provider=fixture.plugin.session_provider().unwrap();
        let launch=provider.open(SessionRequest { session_id:format!("unpolled-input-{expire}"),
            operation:"plugin.independent-session.terminal".into(), input:json!({"mode":"hold"}),
            deadline:(Instant::now()+BUDGET).into_std() },CancellationToken::new()).expect("纯构造未轮询监督");
        let handle=launch.handle; let supervisor=launch.supervisor; let input=handle.input();
        let sending=input.send(b"pending-input"); tokio::pin!(sending);
        // 实际轮询输入等待，监督 Future 保持持有且从未轮询。
        poll_fn(|cx| { assert!(sending.as_mut().poll(cx).is_pending(),"未准备的输入必须等待"); Poll::Ready(()) }).await;
        assert!(!fixture.marker("started").exists()); assert!(!fixture.marker("open").exists());
        if expire { advance(BUDGET).await; } else { input.cancel(); }
        let error=observe(sending,"未轮询监督时输入等待收口").await.expect_err("取消或到期不能无限等待准备");
        if expire { assert!(matches!(error.as_ref(),Error::Timeout)); }
        else { assert!(matches!(error.as_ref(),Error::Cancelled)); }
        assert!(!fixture.marker("started").exists()); assert!(!fixture.marker("start").exists());
        assert!(!provider.has_unresolved_resources()); assert!(!fixture.plugin.has_unresolved_resources());
        drop(supervisor);
    }
}

#[tokio::test(start_paused = true)]
async fn dropping_unpolled_supervisor_caches_ready_failure_and_unconfirmed_exit_without_spawn() {
    let fixture=Fixture::new();
    let provider=fixture.plugin.session_provider().unwrap();
    let launch=provider.open(SessionRequest { session_id:"unpolled-drop".into(),
        operation:"plugin.independent-session.terminal".into(), input:json!({"mode":"hold"}),
        deadline:(Instant::now()+BUDGET).into_std() },CancellationToken::new()).expect("纯构造未轮询监督");
    let mut handle=launch.handle;
    assert!(!fixture.marker("started").exists());
    drop(launch.supervisor);
    let first=observe(handle.ready(),"丢弃未轮询监督后的准备失败").await.expect_err("监督已经丢弃");
    let repeated=observe(handle.ready(),"重复准备失败缓存").await.expect_err("监督已经丢弃");
    assert!(matches!(first.as_ref(),Error::CleanupFailed)); assert!(Arc::ptr_eq(&first,&repeated));
    let exit=observe(handle.wait(),"丢弃未轮询监督后的终态").await;
    let cached=observe(handle.wait(),"重复未轮询终态缓存").await;
    assert!(Arc::ptr_eq(&exit,&cached)); assert_eq!(exit.cleanup,SessionCleanup::Unconfirmed);
    assert!(!exit.process_exited,"从未启动进程，不能虚构退出确认");
    assert!(exit.outcome.is_none()); assert!(exit.sequence.is_none());
    assert!(matches!(exit.failure.as_deref(),Some(Error::CleanupFailed)));
    assert!(!fixture.marker("started").exists()); assert!(!fixture.marker("open").exists()); assert!(!fixture.marker("start").exists());
}

#[tokio::test(start_paused = true)]
async fn wait_discards_unread_output_and_recv_returns_none_after_real_exit() {
    let fixture=Fixture::new();
    let mut running=fixture.launch("drain-unread",json!({"mode":"hold","normal_gate":true}),Instant::now()+BUDGET,CancellationToken::new());
    let pid=fixture.ready(&mut running).await;
    let first=observe(running.handle().recv(),"先读取第一条真实输出").await.expect("第一条输出");
    assert_eq!(first.sequence,1); assert_eq!(first.stream,SessionStream::Stdout); assert_eq!(first.bytes,vec![0,255,10]);
    // 不再读取输出；Finished 原帧的序号证明第二条 stderr 已经发出。
    fixture.release("release-normal").await; let finished=fixture.event("finished").await;
    assert_eq!(support::pid(&finished),pid); assert_eq!(finished["frame"]["session_id"],"drain-unread");
    assert_eq!(finished["frame"]["sequence"],3);
    let exit=running.wait().await;
    assert_eq!(exit.sequence,Some(3)); assert_eq!(exit.cleanup,SessionCleanup::Complete);
    assert!(exit.process_exited); assert!(exit.failure.is_none()); fixture.assert_exited(pid).await;
    assert!(observe(running.handle().recv(),"wait后未读输出队列已排空").await.is_none());
}

#[tokio::test(start_paused = true)]
async fn pending_ready_preserves_published_protocol_error_before_revocation_fallback() {
    let fixture=Fixture::new();
    let provider=fixture.plugin.session_provider().unwrap();
    let launch=provider.open(SessionRequest { session_id:"ready-error-cache".into(),
        operation:"plugin.independent-session.terminal".into(), input:json!({"mode":"wrong-ready-id","ready_gate":true}),
        deadline:(Instant::now()+BUDGET).into_std() },CancellationToken::new()).expect("纯构造真实握手失败会话");
    let mut handle=launch.handle; let mut supervisor=tokio::spawn(launch.supervisor);
    let open=fixture.event("open").await; let pid=support::pid(&open);
    assert_eq!(open["frame"]["session_id"],"ready-error-cache"); assert!(support::liveness::alive(pid));
    let first={
        let waiting=handle.ready(); tokio::pin!(waiting);
        poll_fn(|cx| { assert!(waiting.as_mut().poll(cx).is_pending(),"实际准备等待必须先挂起"); Poll::Ready(()) }).await;
        fixture.release("release-ready").await;
        // 先等待监督发布真实握手错误并关闭输入，再恢复先前挂起的准备等待。
        observe(&mut supervisor,"握手失败后台监督先完成").await.expect("监督不得panic");
        observe(waiting,"已发布真实错误优先于通用关闭错误").await.expect_err("Ready身份不匹配必须失败")
    };
    assert!(matches!(first.as_ref(),Error::Dependency(message) if message=="会话 Ready 关联不匹配"));
    let repeated=observe(handle.ready(),"重复准备保留真实错误缓存").await.expect_err("同一握手失败");
    assert!(Arc::ptr_eq(&first,&repeated));
    let exit=observe(handle.wait(),"真实握手失败终态").await;
    assert!(Arc::ptr_eq(&first,exit.failure.as_ref().expect("终态保留同一真实准备错误")));
    assert_eq!(exit.cleanup,SessionCleanup::Unconfirmed); assert!(exit.process_exited);
    assert!(exit.outcome.is_none()); assert!(exit.sequence.is_none()); fixture.assert_exited(pid).await;
    assert!(!fixture.marker("start").exists(),"无效Ready不能进入Start");
    assert!(provider.has_unresolved_resources()); assert!(fixture.plugin.has_unresolved_resources());
}
