use super::*;
use serde_json::json;
use std::io::Cursor;
use tokio::io::BufReader;

fn codec(sender: Role, receiver: Role) -> Codec {
    Codec::new("call".into(), "a".repeat(64), sender, receiver).unwrap()
}

#[test]
fn identities_roles_and_sequence_cannot_be_replayed() {
    let mut sender = codec(Role::Worker, Role::Coordinator);
    let mut receiver = codec(Role::Coordinator, Role::Worker);
    let frame = sender.encode(json!({"kind":"hello"})).unwrap();
    assert_eq!(receiver.decode(&frame).unwrap()["kind"], "hello");
    assert!(receiver.decode(&frame).is_err());
    for field in [
        "call_id",
        "nonce",
        "role",
        "format_version",
        "sequence",
        "extra",
    ] {
        let mut mutated: Value = serde_json::from_slice(&frame).unwrap();
        mutated[field] = json!("incorrect");
        let mut encoded = serde_json::to_vec(&mutated).unwrap();
        encoded.push(b'\n');
        assert!(
            codec(Role::Coordinator, Role::Worker)
                .decode(&encoded)
                .is_err()
        );
    }
}

#[tokio::test]
async fn bounded_reader_rejects_unterminated_oversized_and_invalid_utf8() {
    for bytes in [
        vec![b'x'; FRAME_LIMIT + 1],
        b"{\"partial\":true}".to_vec(),
        vec![0xff, b'\n'],
    ] {
        let mut reader = BufReader::new(Cursor::new(bytes));
        assert!(
            codec(Role::Coordinator, Role::Worker)
                .read(&mut reader)
                .await
                .is_err()
        );
    }
    let mut reader = BufReader::new(Cursor::new(Vec::<u8>::new()));
    assert!(
        codec(Role::Coordinator, Role::Worker)
            .read(&mut reader)
            .await
            .unwrap()
            .is_none()
    );
}

#[test]
fn serialized_limits_and_bytes_are_checked_before_commit() {
    let mut sender = codec(Role::Worker, Role::Coordinator);
    assert!(
        sender
            .encode(json!({"kind":"large","text":"中".repeat(FRAME_LIMIT)}))
            .is_err()
    );
    let frame = sender.encode(json!({"kind":"hello"})).unwrap();
    let decoded: Frame = serde_json::from_slice(&frame).unwrap();
    assert_eq!(decoded.sequence, 1);
    assert_eq!(bytes(&json!({"bytes":[0,255]})).unwrap(), vec![0, 255]);
    for input in [
        json!({"bytes":[256]}),
        json!({"bytes":[-1]}),
        json!({"bytes":[0.5]}),
        json!({"bytes":null}),
        json!({"bytes":vec![0;CHUNK_LIMIT+1]}),
    ] {
        assert!(bytes(&input).is_err());
    }
}
