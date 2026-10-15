use super::{
    provider::{OPERATION, Provider},
    support::{Harness, finished, output_ready},
    transport::completed,
};
use apk_domain::{
    Error,
    interactive::{SESSION_CHUNK_LIMIT, SessionCleanup, SessionStream},
};
use serde_json::json;
use std::{sync::atomic::Ordering, time::Duration};

#[tokio::test(flavor = "current_thread")]
async fn four_active_and_eight_retained_records_only_reclaim_after_terminal_remove() {
    let (harness, _) = Harness::loaded(Provider::standard()).await;
    let first = (0..4)
        .map(|ordinal| harness.open(&format!("首批{ordinal}")))
        .collect::<Vec<_>>();
    assert!(matches!(
        harness
            .app
            .open_session(OPERATION, json!({"label":"第五活动"})),
        Err(Error::Conflict(_))
    ));
    assert_eq!(harness.provider.opens.load(Ordering::SeqCst), 4);
    assert!(matches!(
        harness.app.session_remove(&first[0].id),
        Err(Error::Conflict(_))
    ));
    for (ordinal, info) in first.iter().enumerate() {
        harness.provider.control(ordinal).finish(completed(1));
        finished(&harness.app, &info.id).await;
    }
    let second = (0..4)
        .map(|ordinal| harness.open(&format!("次批{ordinal}")))
        .collect::<Vec<_>>();
    for (ordinal, info) in second.iter().enumerate() {
        harness.provider.control(ordinal + 4).finish(completed(1));
        finished(&harness.app, &info.id).await;
    }
    assert!(matches!(
        harness
            .app
            .open_session(OPERATION, json!({"label":"第九记录"})),
        Err(Error::Conflict(_))
    ));
    assert_eq!(harness.provider.opens.load(Ordering::SeqCst), 8);
    assert_eq!(harness.app.session_records().len(), 8);
    for info in first.iter().chain(second.iter()) {
        assert!(harness.app.session(&info.id).unwrap().completion.is_some());
    }
    harness.app.session_remove(&first[0].id).unwrap();
    assert_eq!(harness.app.session_records().len(), 7);
    let reclaimed = harness.open("显式删除后");
    assert_eq!(harness.provider.opens.load(Ordering::SeqCst), 9);
    assert_eq!(harness.app.session_records().len(), 8);
    assert!(matches!(
        harness.app.session(&first[0].id),
        Err(Error::NotFound(_))
    ));
    harness.provider.control(8).finish(completed(1));
    finished(&harness.app, &reclaimed.id).await;
    assert!(harness.app.list(20).unwrap().is_empty());
    harness.stop().await;
}

#[tokio::test]
async fn release_cancels_active_session_and_reclaims_record_after_confirmed_cleanup() {
    let provider = Provider::standard();
    provider.hold_cleanup.store(true, Ordering::SeqCst);
    let (harness, _) = Harness::loaded(provider.clone()).await;
    let opened = harness.open("主动释放");
    let control = provider.control(0);
    assert_eq!(
        harness.app.session_release(&opened.id).unwrap().status,
        apk_domain::interactive::SessionStatus::Stopping
    );
    control.wait_cancelled().await;
    assert!(harness.app.session(&opened.id).is_ok());
    control.finish(completed(1));
    tokio::time::timeout(Duration::from_secs(3), async {
        while harness.app.session(&opened.id).is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(matches!(
        harness.app.session(&opened.id),
        Err(Error::NotFound(_))
    ));
    let reopened = harness.open("释放后重新准入");
    provider.control(1).finish(completed(1));
    finished(&harness.app, &reopened.id).await;
    harness.stop().await;
}

#[tokio::test]
async fn release_removes_finished_record_but_preserves_failed_cleanup() {
    let (harness, _) = Harness::loaded(Provider::standard()).await;
    let complete = harness.open("已结束记录");
    harness.provider.control(0).finish(completed(1));
    finished(&harness.app, &complete.id).await;
    assert_eq!(
        harness.app.session_release(&complete.id).unwrap().status,
        apk_domain::interactive::SessionStatus::Finished
    );
    assert!(matches!(
        harness.app.session(&complete.id),
        Err(Error::NotFound(_))
    ));
    let failed = harness.open("清理失败记录");
    harness
        .provider
        .control(1)
        .finish(apk_domain::interactive::SessionExit {
            cleanup: SessionCleanup::Unconfirmed,
            process_exited: false,
            ..completed(1)
        });
    finished(&harness.app, &failed.id).await;
    assert!(matches!(
        harness.app.session_release(&failed.id),
        Err(Error::CleanupFailed)
    ));
    assert!(harness.app.session(&failed.id).is_ok());
    harness.stop().await;
}

#[tokio::test]
async fn total_output_byte_limit_keeps_exact_prefix_and_waits_cancel_cleanup() {
    let (harness, _) = Harness::loaded(Provider::standard()).await;
    let opened = harness.open("总字节上限");
    let control = harness.provider.control(0);
    let producing = {
        let control = control.clone();
        tokio::spawn(async move {
            for sequence in 1..=2048 {
                control
                    .emit(
                        sequence,
                        SessionStream::Stdout,
                        vec![255; SESSION_CHUNK_LIMIT],
                    )
                    .await
                    .unwrap();
            }
            control
                .emit(2049, SessionStream::Stderr, vec![1])
                .await
                .unwrap();
        })
    };
    tokio::time::timeout(Duration::from_secs(10), producing)
        .await
        .unwrap()
        .unwrap();
    let info = finished(&harness.app, &opened.id).await;
    assert_eq!(info.output_sequence, 2048);
    let completion = info.completion.unwrap();
    assert_eq!(completion.failure.unwrap().code, "payload_too_large");
    assert_eq!(completion.cleanup, SessionCleanup::Complete);
    assert!(completion.process_exited);
    assert!(control.supervisor_finished.load(Ordering::SeqCst));
    let mut after = 0;
    let mut bytes = 0;
    loop {
        let page = harness.app.session_output(&opened.id, after, 100).unwrap();
        if page.chunks.is_empty() {
            break;
        }
        for chunk in &page.chunks {
            assert_eq!(chunk.bytes, vec![255; SESSION_CHUNK_LIMIT]);
            bytes += chunk.bytes.len();
        }
        assert!(page.next_sequence > after);
        after = page.next_sequence;
    }
    assert_eq!(after, 2048);
    assert_eq!(bytes, 16 * 1024 * 1024);
    harness.stop().await;
}

#[tokio::test]
async fn output_chunk_count_limit_is_independent_of_byte_limit() {
    let (harness, _) = Harness::loaded(Provider::standard()).await;
    let opened = harness.open("输出块上限");
    let control = harness.provider.control(0);
    let producing = {
        let control = control.clone();
        tokio::spawn(async move {
            for sequence in 1..=65537 {
                control
                    .emit(sequence, SessionStream::Stdout, vec![1])
                    .await
                    .unwrap();
            }
        })
    };
    tokio::time::timeout(Duration::from_secs(10), producing)
        .await
        .unwrap()
        .unwrap();
    let info = finished(&harness.app, &opened.id).await;
    assert_eq!(info.output_sequence, 65536);
    let completion = info.completion.unwrap();
    assert_eq!(completion.failure.unwrap().code, "payload_too_large");
    assert_eq!(completion.cleanup, SessionCleanup::Complete);
    assert!(control.supervisor_finished.load(Ordering::SeqCst));
    let mut after = 0;
    let mut count = 0;
    let mut bytes = 0;
    loop {
        let page = harness.app.session_output(&opened.id, after, 100).unwrap();
        if page.chunks.is_empty() {
            break;
        }
        count += page.chunks.len();
        bytes += page
            .chunks
            .iter()
            .map(|chunk| chunk.bytes.len())
            .sum::<usize>();
        assert!(page.next_sequence > after);
        after = page.next_sequence;
    }
    assert_eq!(after, 65536);
    assert_eq!(count, 65536);
    assert_eq!(bytes, 65536);
    harness.stop().await;
}

#[tokio::test]
async fn malformed_sequence_and_oversized_chunk_do_not_enter_output_cache() {
    for (sequence, bytes, code) in [
        (0, vec![1], "dependency_failed"),
        (2, vec![1], "dependency_failed"),
        (1, vec![1; SESSION_CHUNK_LIMIT + 1], "payload_too_large"),
    ] {
        let (harness, _) = Harness::loaded(Provider::standard()).await;
        let opened = harness.open("非法输出块");
        let control = harness.provider.control(0);
        control
            .emit(sequence, SessionStream::Stdout, bytes)
            .await
            .unwrap();
        let info = finished(&harness.app, &opened.id).await;
        assert_eq!(info.output_sequence, 0);
        assert_eq!(info.completion.unwrap().failure.unwrap().code, code);
        assert!(
            harness
                .app
                .session_output(&opened.id, 0, 100)
                .unwrap()
                .chunks
                .is_empty()
        );
        assert!(control.supervisor_finished.load(Ordering::SeqCst));
        harness.stop().await;
    }
    let (harness, _) = Harness::loaded(Provider::standard()).await;
    let opened = harness.open("重复输出序号");
    let control = harness.provider.control(0);
    control
        .emit(1, SessionStream::Stdout, vec![1])
        .await
        .unwrap();
    output_ready(&harness.app, &opened.id, 1).await;
    control
        .emit(1, SessionStream::Stderr, vec![2])
        .await
        .unwrap();
    let info = finished(&harness.app, &opened.id).await;
    assert_eq!(info.output_sequence, 1);
    assert_eq!(
        info.completion.unwrap().failure.unwrap().code,
        "dependency_failed"
    );
    assert_eq!(
        harness
            .app
            .session_output(&opened.id, 0, 100)
            .unwrap()
            .chunks
            .len(),
        1
    );
    harness.stop().await;
}
