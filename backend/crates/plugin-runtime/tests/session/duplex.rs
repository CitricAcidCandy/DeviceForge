use crate::support::{self, ID, Session, observe};
use apk_plugin_sdk::session::SessionStream;
use deviceforge_plugin_runtime::{Execution, session::SessionOptions};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::oneshot;

#[tokio::test(start_paused = true)]
async fn multiple_raw_inputs_produce_both_outputs_before_handler_finishes_and_empty_is_not_eof() {
    let returned = Arc::new(AtomicBool::new(false));
    let marker = returned.clone();
    let mut session = Session::launch(
        SessionOptions::default(),
        128 * 1024,
        move |open, context, mut input, output| async move {
            assert_eq!(open.session_id, ID);
            assert_eq!(open.input, json!({"中文":"原始帧"}));
            assert!(context.check().is_ok());
            let mut seen = Vec::new();
            while let Some(bytes) = input.recv().await.unwrap() {
                seen.push(bytes.clone());
                output.send(SessionStream::Stdout, &bytes).await.unwrap();
                output
                    .clone()
                    .send(SessionStream::Stderr, &bytes)
                    .await
                    .unwrap();
            }
            assert_eq!(seen, vec![vec![0, 255, 10], vec![], vec![254, 0, 13]]);
            marker.store(true, Ordering::SeqCst);
            Execution::complete(Ok(json!({"blocks":seen.len()}).into()))
        },
    );
    session.begin().await;
    let mut events = Vec::new();
    for bytes in [vec![0, 255, 10], vec![], vec![254, 0, 13]] {
        session.send(&support::input(&bytes)).await;
        for stream in ["stdout", "stderr"] {
            let event = session.line().await;
            assert_eq!(event["event"], "output");
            assert_eq!(event["stream"], stream);
            assert_eq!(event["bytes"], json!(bytes));
            assert!(
                !returned.load(Ordering::SeqCst),
                "未发送 EOF 时 handler 仍未结束"
            );
            events.push(event);
        }
    }
    session.send(&support::eof()).await;
    events.extend(session.terminal().await);
    support::assert_order(&events, 1);
    assert!(returned.load(Ordering::SeqCst));
    assert_eq!(
        events.last().unwrap()["outcome"]["result"],
        json!({"blocks":3})
    );
    assert_eq!(events.last().unwrap()["outcome"]["cleanup"], "complete");
}

#[tokio::test(start_paused = true)]
async fn eof_keeps_control_reader_alive_so_later_cancel_waits_for_real_cleanup() {
    let (eof_seen, observed_eof) = oneshot::channel();
    let (stopped, observed_stop) = oneshot::channel();
    let (release, gate) = oneshot::channel();
    let returned = Arc::new(AtomicBool::new(false));
    let marker = returned.clone();
    let mut session = Session::launch(
        SessionOptions::default(),
        128 * 1024,
        move |_, context, mut input, output| async move {
            assert!(input.recv().await.unwrap().is_none());
            assert!(
                input.recv().await.unwrap().is_none(),
                "已交付 EOF 在同一输入句柄可观察"
            );
            eof_seen.send(()).unwrap();
            output.send(SessionStream::Stdout, &[0, 255]).await.unwrap();
            context.cancellation().cancelled().await;
            stopped.send(()).unwrap();
            gate.await.unwrap();
            marker.store(true, Ordering::SeqCst);
            Execution::complete(Ok(json!({"late":true}).into()))
        },
    );
    session.begin().await;
    session.send(&support::eof()).await;
    observe(observed_eof, "handler 实际读取 EOF").await.unwrap();
    let output = session.line().await;
    assert_eq!(output["bytes"], json!([0, 255]));
    assert!(!returned.load(Ordering::SeqCst));
    session.send(&support::cancel()).await;
    observe(observed_stop, "EOF 后仍接受取消").await.unwrap();
    assert!(!session.running.is_finished());
    release.send(()).unwrap();
    let events = session.terminal().await;
    support::assert_order(&events, 2);
    support::assert_failure(
        events.last().unwrap(),
        apk_plugin_sdk::cooperative::CleanupOutcome::Complete,
    );
    assert!(returned.load(Ordering::SeqCst));
}

#[tokio::test(start_paused = true)]
async fn output_clones_share_sequence_and_normal_finish_drains_admitted_output() {
    let options = SessionOptions::default();
    let (admitted, admission) = oneshot::channel();
    let mut session = Session::launch(options, 128 * 1024, move |_, _, _, output| async move {
        let second = output.clone();
        tokio::join!(
            async {
                for byte in [1, 2, 3] {
                    output.send(SessionStream::Stdout, &[byte]).await.unwrap();
                }
            },
            async {
                for byte in [4, 5, 6] {
                    second.send(SessionStream::Stderr, &[byte]).await.unwrap();
                }
            }
        );
        admitted.send(()).unwrap();
        Execution::complete(Ok(serde_json::Value::Null.into()))
    });
    session.begin().await;
    observe(admission, "六块输出已入队且 handler 可结束")
        .await
        .unwrap();
    let events = session.terminal().await;
    assert_eq!(events.len(), 7);
    support::assert_order(&events, 1);
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    for event in &events[..6] {
        assert_eq!(event["event"], "output");
        let byte = event["bytes"][0].as_u64().unwrap();
        match event["stream"].as_str().unwrap() {
            "stdout" => stdout.push(byte),
            "stderr" => stderr.push(byte),
            _ => panic!("双路枚举"),
        }
    }
    assert_eq!(stdout, [1, 2, 3]);
    assert_eq!(stderr, [4, 5, 6]);
    assert_eq!(
        events[6]["outcome"].get("result"),
        Some(&serde_json::Value::Null),
        "显式 null 成功保留"
    );
    assert_eq!(events[6]["outcome"]["cleanup"], "complete");
}
