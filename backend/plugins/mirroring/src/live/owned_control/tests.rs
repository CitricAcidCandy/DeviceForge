use super::*;
use crate::live::model::{Action, Control};
use deviceforge_plugin_runtime::{Execution, serve_io_with_context};
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::{io::AsyncWriteExt, net::TcpListener, sync::oneshot};

static DEVICES: AtomicU64 = AtomicU64::new(0);

fn parameters() -> Open {
    let ordinal = DEVICES.fetch_add(1, Ordering::Relaxed);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    serde_json::from_value(json!({
        "device_id": format!("ownership-socket-{}-{timestamp}-{ordinal}", std::process::id()),
        "control": true,
        "audio": false,
        "clipboard_autosync": true,
    }))
    .unwrap()
}

fn config() -> Config {
    Config {
        format_version: 1,
        scrcpy: "unused-scrcpy".into(),
        adb: "missing-ownership-test-adb".into(),
        live: None,
    }
}

async fn context() -> InvocationContext {
    let (mut client, server) = tokio::io::duplex(4096);
    let (reader, writer) = tokio::io::split(server);
    let (sender, receiver) = oneshot::channel();
    let running = tokio::spawn(serve_io_with_context(
        reader,
        writer,
        move |_, context| async move {
            sender.send(context).unwrap();
            Execution::complete(Ok(json!(null).into()))
        },
    ));
    client.write_all(b"{\"protocol_version\":4,\"request_id\":\"owned-control\",\"operation\":\"test\",\"input\":{}}\n{\"protocol_version\":4,\"request_id\":\"owned-control\",\"command\":\"start\",\"remaining_timeout_ns\":60000000000}\n").await.unwrap();
    let context = receiver.await.unwrap();
    running.await.unwrap().unwrap();
    context
}

async fn socket(control: &mut OwnedControl<'_>) -> TcpStream {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let local = TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (remote, _) = listener.accept().await.unwrap();
    control.socket = Some(local);
    control.device = Some(Device::new());
    remote
}

fn key(action: Action) -> Vec<u8> {
    Control::Key {
        action,
        keycode: 29,
        repeat: 0,
        meta_state: 0,
    }
    .encode()
    .unwrap()
}

async fn no_bytes(remote: &mut TcpStream) {
    let mut buffer = [0_u8; 128];
    assert!(
        tokio::time::timeout(Duration::from_millis(40), remote.read(&mut buffer))
            .await
            .is_err()
    );
}

async fn read_exact(remote: &mut TcpStream, bytes: &mut [u8]) {
    tokio::time::timeout(Duration::from_secs(1), remote.read_exact(bytes))
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn current_generation_sends_exact_bytes_and_queued_request_does_not_swallow_key_up() {
    let config = config();
    let parameters = parameters();
    let context = context().await;
    let mut alice = OwnedControl::new(&parameters, "alice", false, &config)
        .await
        .unwrap();
    let mut remote = socket(&mut alice).await;
    let revision = alice
        .clipboard_guard()
        .await
        .unwrap()
        .view()
        .control_revision;
    let down = key(Action::Down);
    alice.send(&down, Some(revision), &context).await.unwrap();
    let mut received = vec![0; down.len()];
    read_exact(&mut remote, &mut received).await;
    assert_eq!(received, down);
    let mut bob = OwnedControl::new(&parameters, "bob", false, &config)
        .await
        .unwrap();
    let changed = bob.command(Command::Request).await.unwrap();
    assert_eq!(changed.control_revision, revision);
    let up = key(Action::Up);
    alice.send(&up, Some(revision), &context).await.unwrap();
    read_exact(&mut remote, &mut received).await;
    assert_eq!(received, up);
    assert!(bob.close().await);
    assert!(alice.close().await);
}

#[tokio::test]
async fn stale_generation_and_non_owner_send_zero_bytes() {
    let config = config();
    let parameters = parameters();
    let context = context().await;
    let mut alice = OwnedControl::new(&parameters, "alice", false, &config)
        .await
        .unwrap();
    let mut remote = socket(&mut alice).await;
    let revision = alice
        .clipboard_guard()
        .await
        .unwrap()
        .view()
        .control_revision;
    alice
        .send(&key(Action::Down), revision.checked_sub(1), &context)
        .await
        .unwrap();
    no_bytes(&mut remote).await;
    let mut bob = OwnedControl::new(&parameters, "bob", false, &config)
        .await
        .unwrap();
    let mut bob_remote = socket(&mut bob).await;
    bob.send(&key(Action::Down), Some(revision), &context)
        .await
        .unwrap();
    no_bytes(&mut bob_remote).await;
    assert!(bob.close().await);
    assert!(alice.close().await);
}

#[tokio::test]
async fn handoff_blocks_old_input_then_writes_key_up_before_granting_successor() {
    let config = config();
    let parameters = parameters();
    let context = context().await;
    let mut alice = OwnedControl::new(&parameters, "alice", false, &config)
        .await
        .unwrap();
    let mut remote = socket(&mut alice).await;
    let revision = alice
        .clipboard_guard()
        .await
        .unwrap()
        .view()
        .control_revision;
    let down = key(Action::Down);
    alice.send(&down, Some(revision), &context).await.unwrap();
    let mut received = vec![0; down.len()];
    read_exact(&mut remote, &mut received).await;
    let mut bob = OwnedControl::new(&parameters, "bob", false, &config)
        .await
        .unwrap();
    bob.command(Command::Request).await.unwrap();
    let state = alice
        .command(Command::Respond {
            client_id: "bob".into(),
            accept: true,
        })
        .await
        .unwrap();
    assert!(state.transitioning);
    alice.send(&down, Some(revision), &context).await.unwrap();
    no_bytes(&mut remote).await;
    let finished = alice.refresh(&context).await.unwrap();
    read_exact(&mut remote, &mut received).await;
    assert_eq!(received, key(Action::Up));
    assert!(!finished.has_control);
    assert_eq!(finished.owner_id.as_deref(), Some("bob"));
    assert!(bob.clipboard_guard().await.unwrap().is_owner());
    assert!(bob.close().await);
    assert!(alice.close().await);
}

#[tokio::test]
async fn close_releases_pressed_touch_and_key_before_socket_shutdown() {
    let config = config();
    let parameters = parameters();
    let context = context().await;
    let mut alice = OwnedControl::new(&parameters, "alice", false, &config)
        .await
        .unwrap();
    let mut remote = socket(&mut alice).await;
    let revision = alice
        .clipboard_guard()
        .await
        .unwrap()
        .view()
        .control_revision;
    let touch = Control::Touch {
        action: Action::Down,
        pointer_id: 1,
        x: 2,
        y: 3,
        width: 100,
        height: 100,
        pressure: 1.0,
    }
    .encode()
    .unwrap();
    let down = key(Action::Down);
    alice.send(&touch, Some(revision), &context).await.unwrap();
    alice.send(&down, Some(revision), &context).await.unwrap();
    let mut sent = vec![0; touch.len() + down.len()];
    read_exact(&mut remote, &mut sent).await;
    assert!(alice.close().await);
    let mut released = Vec::new();
    tokio::time::timeout(Duration::from_secs(1), remote.read_to_end(&mut released))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(released.len(), touch.len() + down.len());
    assert_eq!(released[1], 1);
    assert_eq!(&released[22..32], &[0; 10]);
    assert_eq!(&released[32..], &key(Action::Up));
}

#[tokio::test]
async fn failed_device_cleanup_keeps_handoff_blocked_and_never_grants_successor() {
    let config = config();
    let parameters = parameters();
    let context = context().await;
    let mut alice = OwnedControl::new(&parameters, "alice", false, &config)
        .await
        .unwrap();
    let _remote = socket(&mut alice).await;
    alice.device.as_mut().unwrap().unresolved = true;
    let mut master = OwnedControl::new(&parameters, "master", true, &config)
        .await
        .unwrap();
    master.command(Command::Reclaim).await.unwrap();
    assert!(alice.refresh(&context).await.is_err());
    assert!(!master.clipboard_guard().await.unwrap().is_owner());
    assert!(!alice.close().await);
    let state = master.clipboard_guard().await.unwrap().view();
    assert!(state.blocked);
    assert!(!state.has_control);
    assert!(master.command(Command::Reclaim).await.is_err());
    assert!(master.close().await);
}

#[tokio::test]
async fn missing_socket_with_pressed_input_cannot_report_successful_cleanup() {
    let config = config();
    let parameters = parameters();
    let mut alice = OwnedControl::new(&parameters, "alice", false, &config)
        .await
        .unwrap();
    alice.device = Some(Device::new());
    alice.pressed.record(&key(Action::Down)).unwrap();
    assert!(!alice.pressed.is_empty());
    assert!(!alice.close().await);
    assert!(alice.clipboard_guard().await.unwrap().view().blocked);
}
