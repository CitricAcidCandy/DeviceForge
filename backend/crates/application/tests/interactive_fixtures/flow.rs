use super::{
    provider::Provider,
    support::{Harness, finished, output_ready, status},
    transport::completed,
};
use apk_domain::{
    Error,
    interactive::{SESSION_CHUNK_LIMIT, SessionChunk, SessionStatus, SessionStream},
};
use std::sync::atomic::Ordering;

#[tokio::test]
async fn original_binary_streams_keep_sequence_and_exclusive_cursor_after_completion() {
    let (harness, _) = Harness::loaded(Provider::standard()).await;
    let opened = harness.open("原字节游标");
    let control = harness.provider.control(0);
    let expected = vec![
        SessionChunk {
            sequence: 1,
            stream: SessionStream::Stdout,
            bytes: vec![0, 255, 13, 10],
        },
        SessionChunk {
            sequence: 2,
            stream: SessionStream::Stderr,
            bytes: vec![240, 159],
        },
        SessionChunk {
            sequence: 3,
            stream: SessionStream::Stdout,
            bytes: vec![152, 128, 0],
        },
        SessionChunk {
            sequence: 4,
            stream: SessionStream::Stderr,
            bytes: vec![128, 254, 10],
        },
    ];
    for chunk in &expected {
        control
            .emit(chunk.sequence, chunk.stream, chunk.bytes.clone())
            .await
            .unwrap();
    }
    output_ready(&harness.app, &opened.id, 4).await;
    let first = harness.app.session_output(&opened.id, 0, 2).unwrap();
    assert_eq!(first.chunks, expected[..2]);
    assert_eq!(first.next_sequence, 2);
    assert_eq!(first.session.id, opened.id);
    assert_eq!(first.session.output_sequence, 4);
    assert_eq!(first.session.status, SessionStatus::Running);
    let second = harness
        .app
        .session_output(&opened.id, first.next_sequence, 1)
        .unwrap();
    assert_eq!(second.chunks, expected[2..3]);
    assert_eq!(second.next_sequence, 3);
    let third = harness
        .app
        .session_output(&opened.id, second.next_sequence, 100)
        .unwrap();
    assert_eq!(third.chunks, expected[3..]);
    assert_eq!(third.next_sequence, 4);
    let empty = harness.app.session_output(&opened.id, 4, 100).unwrap();
    assert!(empty.chunks.is_empty());
    assert_eq!(empty.next_sequence, 4);
    for limit in [0, 101] {
        assert!(matches!(
            harness.app.session_output(&opened.id, 0, limit),
            Err(Error::Invalid(_))
        ));
    }
    assert!(matches!(
        harness.app.session_output(&opened.id, 5, 1),
        Err(Error::Invalid(_))
    ));
    control.finish(completed(5));
    let final_info = finished(&harness.app, &opened.id).await;
    assert_eq!(final_info.output_sequence, 4);
    assert_eq!(final_info.completion.as_ref().unwrap().sequence, Some(5));
    assert_eq!(
        harness
            .app
            .session_output(&opened.id, 0, 100)
            .unwrap()
            .chunks,
        expected
    );
    assert!(matches!(
        harness.app.session_output(&opened.id, 5, 1),
        Err(Error::Invalid(_))
    ));
    harness.app.session_remove(&opened.id).unwrap();
    assert!(matches!(
        harness.app.session(&opened.id),
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        harness.app.session_output(&opened.id, 0, 1),
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        harness.app.session_remove(&opened.id),
        Err(Error::NotFound(_))
    ));
    harness.stop().await;
}

#[tokio::test]
async fn shared_runtime_input_preserves_empty_bytes_and_eof_is_not_empty_send() {
    let (harness, _) = Harness::loaded(Provider::standard()).await;
    let opened = harness.open("运行输入与EOF");
    let control = harness.provider.control(0);
    status(&harness.app, &opened.id, SessionStatus::Running).await;
    for bytes in [vec![0, 255, 10], Vec::new(), vec![13, 128]] {
        harness.app.session_send(&opened.id, &bytes).await.unwrap();
    }
    assert_eq!(
        *control.input.writes.lock().unwrap(),
        vec![vec![0, 255, 10], Vec::new(), vec![13, 128]]
    );
    assert_eq!(control.input.eof_calls.load(Ordering::SeqCst), 0);
    assert!(matches!(
        harness
            .app
            .session_send(&opened.id, &vec![1; SESSION_CHUNK_LIMIT + 1])
            .await,
        Err(Error::TooLarge)
    ));
    assert_eq!(control.input.writes.lock().unwrap().len(), 3);
    harness.app.session_eof(&opened.id).await.unwrap();
    assert_eq!(control.input.eof_calls.load(Ordering::SeqCst), 1);
    assert!(harness.app.session_eof(&opened.id).await.is_err());
    assert!(
        harness
            .app
            .session_send(&opened.id, "EOF后".as_bytes())
            .await
            .is_err()
    );
    assert_eq!(control.input.writes.lock().unwrap().len(), 3);
    control
        .emit(1, SessionStream::Stdout, vec![255, 0])
        .await
        .unwrap();
    output_ready(&harness.app, &opened.id, 1).await;
    control.finish(completed(2));
    finished(&harness.app, &opened.id).await;
    assert!(
        harness
            .app
            .session_send(&opened.id, "结束后".as_bytes())
            .await
            .is_err()
    );
    assert!(harness.app.session_eof(&opened.id).await.is_err());
    assert_eq!(control.input.writes.lock().unwrap().len(), 3);
    assert!(matches!(
        harness.app.session_send("missing", "未知".as_bytes()).await,
        Err(Error::NotFound(_))
    ));
    assert!(matches!(
        harness.app.session_eof("missing").await,
        Err(Error::NotFound(_))
    ));
    harness.stop().await;
}
