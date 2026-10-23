use crate::support::{self, BUDGET, Session, observe};
use apk_plugin_sdk::{cooperative::CleanupOutcome, session::SessionStream};
use deviceforge_plugin_runtime::{
    Execution,
    session::{SessionIoError, SessionOptions},
};
use serde_json::json;
use std::{
    future::{Future, poll_fn},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::Poll,
    time::Duration,
};
use tokio::{io::AsyncReadExt, sync::oneshot, time::advance};

#[test]
fn defaults_and_option_boundaries_keep_finite_queues_and_transport_budgets() {
    let defaults = SessionOptions::default();
    assert_eq!(defaults.channel_capacity, 8);
    assert_eq!(defaults.input_limit, 1024 * 1024);
    assert_eq!(defaults.output_limit, 16 * 1024 * 1024);
    assert_eq!(defaults.handshake_timeout, Duration::from_secs(5));
    assert_eq!(defaults.transport_grace, Duration::from_secs(2));
    assert!(defaults.validate().is_ok());
    let maximum = SessionOptions {
        channel_capacity: 64,
        input_limit: 64 * 1024 * 1024,
        output_limit: 64 * 1024 * 1024,
        continuous_output: false,
        handshake_timeout: Duration::from_secs(30),
        transport_grace: Duration::from_secs(5),
    };
    assert!(maximum.validate().is_ok());
    for case in 0..8 {
        let mut options = defaults;
        match case {
            0 => options.channel_capacity = 0,
            1 => options.channel_capacity = 65,
            2 => options.input_limit = 64 * 1024 * 1024 + 1,
            3 => options.output_limit = 64 * 1024 * 1024 + 1,
            4 => options.handshake_timeout = Duration::ZERO,
            5 => options.handshake_timeout = Duration::from_secs(30) + Duration::from_nanos(1),
            6 => options.transport_grace = Duration::ZERO,
            _ => options.transport_grace = Duration::from_secs(5) + Duration::from_nanos(1),
        }
        assert!(options.validate().is_err());
    }
}

#[tokio::test(start_paused = true)]
async fn input_total_limit_and_queue_overflow_cancel_without_blocking_control() {
    for queue_full in [false, true] {
        let options = SessionOptions {
            channel_capacity: if queue_full { 1 } else { 8 },
            input_limit: if queue_full { 1024 } else { 3 },
            ..SessionOptions::default()
        };
        let (entered, entry) = oneshot::channel();
        let (stopped, stop) = oneshot::channel();
        let (release, gate) = oneshot::channel();
        let mut session = Session::launch(
            options,
            128 * 1024,
            move |_, context, mut input, _| async move {
                entered.send(()).expect("报告处理器已真实进入");
                context.cancellation().cancelled().await;
                stopped.send(()).unwrap();
                gate.await.unwrap();
                assert!(matches!(input.recv().await, Err(SessionIoError::Cancelled)));
                Execution {
                    outcome: Ok(json!({"late":true}).into()),
                    cleanup: CleanupOutcome::Failed,
                }
            },
        );
        session.begin().await;
        observe(entry, "先确认处理器已进入，再制造输入超限或满队列")
            .await
            .expect("已启动处理器发送独立进入证据");
        session.send(&support::input(&[1, 2])).await;
        session.send(&support::input(&[3, 4])).await;
        observe(stop, "满输入或超限不会阻塞控制监督").await.unwrap();
        assert!(!session.running.is_finished());
        release.send(()).unwrap();
        let events = session.terminal().await;
        support::assert_failure(&events[0], CleanupOutcome::Failed);
        let message = events[0]["outcome"]["error"].as_str().unwrap();
        assert!(
            message.contains(if queue_full { "队列" } else { "累计输入" }),
            "区分有界输入拒绝原因：{message}"
        );
    }
}

#[tokio::test(start_paused = true)]
async fn output_chunk_and_shared_total_limits_cancel_even_if_handler_ignores_error() {
    for oversized_chunk in [false, true] {
        let options = SessionOptions {
            output_limit: 3,
            continuous_output: oversized_chunk,
            ..SessionOptions::default()
        };
        let (reported, error) = oneshot::channel();
        let mut session = Session::launch(
            options,
            128 * 1024,
            move |_, context, _, output| async move {
                let result = if oversized_chunk {
                    output.send(SessionStream::Stdout, &vec![7; 8193]).await
                } else {
                    output.send(SessionStream::Stdout, &[1, 2]).await.unwrap();
                    output.clone().send(SessionStream::Stderr, &[3, 4]).await
                };
                reported.send(result).unwrap();
                assert!(context.cancellation().is_cancelled());
                Execution {
                    outcome: Ok(json!({"late":true}).into()),
                    cleanup: CleanupOutcome::Failed,
                }
            },
        );
        session.begin().await;
        let error = observe(error, "公开输出错误").await.unwrap();
        if oversized_chunk {
            assert!(matches!(
                error,
                Err(SessionIoError::ChunkTooLarge { limit: 8192 })
            ));
        } else {
            assert!(matches!(
                error,
                Err(SessionIoError::OutputTooLarge { limit: 3 })
            ));
        }
        let events = session.terminal().await;
        support::assert_failure(events.last().unwrap(), CleanupOutcome::Failed);
    }
}

#[tokio::test(start_paused = true)]
async fn exact_combined_output_limit_succeeds_across_clones_and_streams() {
    let options = SessionOptions {
        output_limit: 3,
        ..SessionOptions::default()
    };
    let mut session = Session::launch(options, 128 * 1024, |_, _, _, output| async move {
        output.send(SessionStream::Stdout, &[0, 255]).await.unwrap();
        output
            .clone()
            .send(SessionStream::Stderr, &[254])
            .await
            .unwrap();
        Execution::complete(Ok(json!({"exact":3}).into()))
    });
    session.begin().await;
    let events = session.terminal().await;
    assert_eq!(events.len(), 3);
    support::assert_order(&events, 1);
    assert_eq!(events[0]["bytes"], json!([0, 255]));
    assert_eq!(events[1]["bytes"], json!([254]));
    assert_eq!(events[2]["outcome"]["result"], json!({"exact":3}));
}

#[tokio::test(start_paused = true)]
async fn continuous_output_keeps_order_and_chunk_limits_beyond_cumulative_budget() {
    let options = SessionOptions {
        output_limit: 1,
        continuous_output: true,
        ..SessionOptions::default()
    };
    let mut session = Session::launch(options, 128 * 1024, |_, _, _, output| async move {
        output.send(SessionStream::Stdout, &[0, 255]).await.unwrap();
        output
            .clone()
            .send(SessionStream::Stderr, &[254, 1])
            .await
            .unwrap();
        Execution::complete(Ok(json!({"continuous":true}).into()))
    });
    session.begin().await;
    let events = session.terminal().await;
    support::assert_order(&events, 1);
    assert_eq!(events.len(), 3);
    assert_eq!(events[0]["bytes"], json!([0, 255]));
    assert_eq!(events[1]["bytes"], json!([254, 1]));
    assert_eq!(events[2]["outcome"]["result"], json!({"continuous":true}));
}

#[tokio::test(start_paused = true)]
async fn full_output_queue_with_zero_written_bytes_is_interruptible_by_cancel_or_original_deadline()
{
    for timeout in [false, true] {
        let options = SessionOptions {
            channel_capacity: 1,
            ..SessionOptions::default()
        };
        let accepted = Arc::new(AtomicUsize::new(0));
        let count = accepted.clone();
        let (blocked, block) = oneshot::channel();
        let (stopped, stop) = oneshot::channel();
        let (release, gate) = oneshot::channel();
        let mut session = Session::launch(options, 128 * 1024, move |_, _, _, output| async move {
            let mut sending = Box::pin(async {
                for _ in 0..64 {
                    output.send(SessionStream::Stdout, &[255; 8192]).await?;
                    count.fetch_add(1, Ordering::SeqCst);
                }
                Ok::<(), SessionIoError>(())
            });
            poll_fn(|cx| {
                assert!(
                    sending.as_mut().poll(cx).is_pending(),
                    "单槽队列不能一次准入64块"
                );
                Poll::Ready(())
            })
            .await;
            blocked.send(()).unwrap();
            let result = sending.await;
            stopped.send(result).unwrap();
            gate.await.unwrap();
            Execution {
                outcome: Ok(json!({"late":true}).into()),
                cleanup: CleanupOutcome::Failed,
            }
        });
        session.handshake().await;
        session.write_gate.stop();
        session.send(&support::start(BUDGET)).await;
        observe(block, "输出发送被真实轮询至Pending").await.unwrap();
        assert!(accepted.load(Ordering::SeqCst) <= 2);
        if timeout {
            advance(BUDGET + Duration::from_millis(1)).await;
        } else {
            session.send(&support::cancel()).await;
        }
        let error = observe(stop, "背压发送被原停止条件解除").await.unwrap();
        assert!(matches!(
            error,
            Err(SessionIoError::Cancelled | SessionIoError::Timeout)
        ));
        assert!(!session.running.is_finished());
        release.send(()).unwrap();
        session.write_gate.release();
        let events = session.terminal().await;
        assert_eq!(events.len(), 1, "零字节待发输出丢弃后只发送终态");
        support::assert_order(&events, 1);
        support::assert_failure(&events[0], CleanupOutcome::Failed);
        if timeout {
            assert!(
                events[0]["outcome"]["error"]
                    .as_str()
                    .unwrap()
                    .contains("期限")
            );
        }
    }
}

#[tokio::test(start_paused = true)]
async fn partially_written_output_never_appends_finished_but_waits_for_real_cleanup() {
    for timeout in [false, true] {
        let options = SessionOptions {
            channel_capacity: 1,
            ..SessionOptions::default()
        };
        let (stopped, stop) = oneshot::channel();
        let (release, gate) = oneshot::channel();
        let returned = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let marker = returned.clone();
        let mut session = Session::launch(options, 256, move |_, context, _, output| async move {
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
            stopped.send(()).unwrap();
            gate.await.unwrap();
            marker.store(true, Ordering::SeqCst);
            Execution {
                outcome: Ok(json!({"late":true}).into()),
                cleanup: CleanupOutcome::Failed,
            }
        });
        session.begin().await;
        let mut prefix = [0; 16];
        observe(
            session.reader.read_exact(&mut prefix),
            "实际读取输出JSON前16字节",
        )
        .await
        .unwrap();
        assert_eq!(prefix[0], b'{');
        assert!(!prefix.contains(&b'\n'), "只有部分输出帧已写出");
        if timeout {
            advance(BUDGET + Duration::from_millis(1)).await;
        } else {
            session.send(&support::cancel()).await;
        }
        observe(stop, "半帧传输中断通知处理器清理").await.unwrap();
        assert!(!returned.load(Ordering::SeqCst));
        assert!(
            !session.running.is_finished(),
            "传输失败也须保留处理器至真实清理"
        );
        release.send(()).unwrap();
        observe(
            async {
                while !returned.load(Ordering::SeqCst) {
                    tokio::task::yield_now().await;
                }
            },
            "持续背压时真实处理器仍须完成清理",
        )
        .await;
        advance(options.transport_grace + Duration::from_millis(1)).await;
        let result = observe(&mut session.running, "真实清理后返回传输错误")
            .await
            .unwrap();
        assert!(result.is_err());
        assert!(returned.load(Ordering::SeqCst));
        let mut tail = Vec::new();
        observe(session.reader.read_to_end(&mut tail), "半帧后关闭输出")
            .await
            .unwrap();
        let mut bytes = prefix.to_vec();
        bytes.extend(tail);
        assert!(!bytes.contains(&b'\n'), "不能在残缺JSON后追加Finished行");
        assert!(!String::from_utf8_lossy(&bytes).contains("finished"));
        assert!(serde_json::from_slice::<serde_json::Value>(&bytes).is_err());
    }
}
