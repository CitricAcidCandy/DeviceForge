//! 取消时只补完已经开始的帧，随后交付真实清理终态，不继续业务输出。
use crate::support::{self, BUDGET, Session, observe};
use apk_plugin_sdk::{cooperative::CleanupOutcome, session::SessionStream};
use deviceforge_plugin_runtime::{Execution, session::SessionOptions};
use serde_json::json;
use tokio::{
    io::AsyncReadExt,
    sync::oneshot,
    time::{Duration, advance},
};

#[tokio::test(start_paused = true)]
async fn cancelled_partial_frame_can_finish_before_real_cleanup_confirmation() {
    for expired in [false, true] {
        let (stopped, stop) = oneshot::channel();
        let (release, gate) = oneshot::channel();
        let mut session = Session::launch(
            SessionOptions::default(),
            256,
            move |_, context, _, output| async move {
                for _ in 0..64 {
                    if output
                        .send(SessionStream::Stdout, &[255; 8192])
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                context.cancellation().cancelled().await;
                assert!(
                    output
                        .send(SessionStream::Stdout, b"late-business")
                        .await
                        .is_err()
                );
                stopped.send(()).unwrap();
                gate.await.unwrap();
                Execution::complete(Ok(json!({"late":true}).into()))
            },
        );
        session.begin().await;
        let mut prefix = [0; 16];
        observe(session.reader.read_exact(&mut prefix), "输出帧已真实开始")
            .await
            .unwrap();
        assert_eq!(prefix[0], b'{');
        assert!(!prefix.contains(&b'\n'));
        if expired {
            advance(BUDGET + Duration::from_millis(1)).await;
        } else {
            session.send(&support::cancel()).await;
        }
        observe(stop, "处理器进入真实清理").await.unwrap();
        assert!(!session.running.is_finished());
        release.send(()).unwrap();
        let mut bytes = prefix.to_vec();
        observe(session.reader.read_to_end(&mut bytes), "补全单帧与真实终态")
            .await
            .unwrap();
        observe(&mut session.running, "传输完整结束")
            .await
            .unwrap()
            .expect("可恢复的在途帧不应丢失清理确认");
        let events: Vec<serde_json::Value> = bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).unwrap())
            .collect();
        assert_eq!(events.len(), 2, "只补完一帧后发送终态，不发送新业务");
        support::assert_order(&events, 1);
        assert_eq!(
            events[0]["bytes"],
            serde_json::to_value(vec![255u8; 8192]).unwrap()
        );
        support::assert_failure(&events[1], CleanupOutcome::Complete);
        assert!(!String::from_utf8_lossy(&bytes).contains("late-business"));
    }
}

#[tokio::test(start_paused = true)]
async fn recovered_frame_and_finished_share_one_deadline_even_if_handler_is_late() {
    let options = SessionOptions::default();
    let (stopped, stop) = oneshot::channel();
    let (release, gate) = oneshot::channel();
    let mut session = Session::launch(options, 256, move |_, context, _, output| async move {
        output
            .send(SessionStream::Stdout, &[255; 8192])
            .await
            .unwrap();
        context.cancellation().cancelled().await;
        stopped.send(()).unwrap();
        gate.await.unwrap();
        Execution::complete(Ok(json!(null).into()))
    });
    session.begin().await;
    let mut prefix = [0; 16];
    observe(session.reader.read_exact(&mut prefix), "在途帧已开始")
        .await
        .unwrap();
    session.send(&support::cancel()).await;
    observe(stop, "真实处理器仍在清理").await.unwrap();
    let mut frame = prefix.to_vec();
    use tokio::io::AsyncBufReadExt;
    observe(
        session.reader.read_until(b'\n', &mut frame),
        "在宽限内只补完当前帧",
    )
    .await
    .unwrap();
    let event: serde_json::Value = serde_json::from_slice(&frame).unwrap();
    assert_eq!(event["event"], "output");
    assert!(
        !session.running.is_finished(),
        "没有真实Execution不能发Finished"
    );
    advance(options.transport_grace + Duration::from_millis(1)).await;
    release.send(()).unwrap();
    let error = observe(&mut session.running, "迟到Execution不得重新授时")
        .await
        .unwrap()
        .expect_err("终态不能获得新宽限");
    assert!(error.contains("宽限"));
    let mut tail = Vec::new();
    observe(session.reader.read_to_end(&mut tail), "超期终态没有写入")
        .await
        .unwrap();
    assert!(tail.is_empty());
}
