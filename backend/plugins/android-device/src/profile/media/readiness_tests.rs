//! 真实本地 TCP 夹具只验证就绪协议和取消，不启动 ADB、scrcpy 或共享服务。
use super::Device;
use crate::{
    Control, Error,
    session::{self, Session},
};
use std::{net::Ipv4Addr, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

async fn session() -> Session {
    Session {
        profile_root: None,
        control: Control::new(session::lifecycle::context().await, "unused-ADB".into()),
    }
}
fn header() -> [u8; 13] {
    let mut value = [0; 13];
    value[1..5].copy_from_slice(b"h264");
    value[5..9].copy_from_slice(&640_u32.to_be_bytes());
    value[9..].copy_from_slice(&288_u32.to_be_bytes());
    value
}

#[tokio::test]
async fn early_eof_reconnects_and_codec_header_is_consumed_exactly_once() {
    let session = session().await;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let mut device = Device::new();
    device.port = Some(listener.local_addr().unwrap().port());
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        first.write_all(&header()[..6]).await.unwrap();
        drop(first);
        let (mut second, _) = listener.accept().await.unwrap();
        second.write_all(&header()).await.unwrap();
        second.write_all(b"packet").await.unwrap();
    });
    let connected = tokio::time::timeout(Duration::from_secs(3), device.connect(&session)).await;
    if !matches!(&connected, Ok(Ok(_))) {
        server.abort();
    }
    let server_result = server.await;
    let (mut socket, actual_header) = connected.unwrap().unwrap();
    server_result.unwrap();
    assert_eq!(actual_header.as_slice(), &header()[1..]);
    let mut payload = [0; 6];
    tokio::time::timeout(Duration::from_secs(1), socket.read_exact(&mut payload))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&payload, b"packet");
}

#[tokio::test]
async fn pending_codec_header_obeys_context_cancel_and_releases_socket_tasks() {
    let session = session().await;
    let cancel = session.control.context.cancellation();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let mut device = Device::new();
    device.port = Some(listener.local_addr().unwrap().port());
    let (accepted, ready) = oneshot::channel();
    let (release, closed) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        accepted.send(()).unwrap();
        let _ = closed.await;
        drop(socket);
    });
    let mut connecting = tokio::spawn(async move { device.connect(&session).await });
    let ready = tokio::time::timeout(Duration::from_secs(2), ready).await;
    if !matches!(&ready, Ok(Ok(()))) {
        cancel.cancel();
        connecting.abort();
        let _ = connecting.await;
        server.abort();
        let _ = server.await;
        panic!("本地就绪夹具未及时接到连接");
    }
    cancel.cancel();
    let outcome = tokio::time::timeout(Duration::from_secs(2), &mut connecting).await;
    let _ = release.send(());
    server.await.unwrap();
    if outcome.is_err() {
        connecting.abort();
        let _ = connecting.await;
    }
    assert!(matches!(outcome, Ok(Ok(Err(Error::Cancelled)))));
}
