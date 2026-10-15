mod media;
mod peer;
mod reader;
mod signaling;

use super::{
    checked,
    device::Device,
    model::{Control, Open},
};
use crate::config::Config;
use apk_plugin_sdk::cooperative::CleanupOutcome;
use deviceforge_plugin_runtime::{
    Execution, InvocationContext,
    session::{SessionInput, SessionOutput},
};
use peer::Peer;
use serde_json::json;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;

pub(super) async fn run(
    mut open: Open,
    config: Config,
    context: InvocationContext,
    mut input: SessionInput,
    output: SessionOutput,
) -> Execution {
    open.reconnect_attempts = 0;
    open.audio = false;
    let mut device = Device::new();
    let mut peer = None;
    let mut unresolved = false;
    let mut prepared = open.clone();
    prepared.control = true;
    let result = async {
        signaling::status(&output, "connecting").await?;
        if let Err(error) = device
            .prepare_with_audio_codec(&config, &prepared, &context, "raw")
            .await
        {
            if error == "ADB直播直接进程清理未确认" {
                device.unresolved = true;
            }
            return Err(error);
        }
        let video = device.connect(&context).await?;
        let audio = if open.audio {
            Some(device.connect(&context).await?)
        } else {
            None
        };
        let control = device.connect(&context).await?;
        let active_peer = negotiate(video, audio, &context, &mut input, &output).await?;
        peer = Some(active_peer.0);
        let session = MediaSession {
            video: active_peer.1,
            audio: active_peer.2,
            control,
            config: active_peer.3,
            reader: active_peer.4,
        };
        pump(
            &mut device,
            &open,
            &context,
            &mut input,
            &output,
            peer.as_mut().ok_or("WebRTC 连接缺失")?,
            session,
        )
        .await
    }
    .await;
    if result
        .as_ref()
        .is_err_and(|error| cleanup_unconfirmed(error))
    {
        unresolved = true;
    }
    let peer_clean = if let Some(peer) = &peer {
        peer.close().await
    } else {
        true
    };
    let device_clean = device.cleanup(&config, &prepared).await;
    if unresolved || !peer_clean || !device_clean {
        return Execution {
            outcome: Err("WebRTC 或设备资源清理未确认".into()),
            cleanup: CleanupOutcome::Failed,
        };
    }
    Execution::complete(result.map(|_| {
        json!({"device_id":open.device_id,"epoch":1,"live_stream":true,"transport":"webrtc"}).into()
    }))
}

fn cleanup_unconfirmed(error: &str) -> bool {
    error.contains("资源清理未确认")
}

type Negotiated = (
    Peer,
    reader::Reader,
    Option<reader::Reader>,
    Vec<u8>,
    signaling::Reader,
);

struct MediaSession {
    video: reader::Reader,
    audio: Option<reader::Reader>,
    control: TcpStream,
    config: Vec<u8>,
    reader: signaling::Reader,
}

async fn negotiate(
    mut video: TcpStream,
    mut audio: Option<TcpStream>,
    context: &InvocationContext,
    input: &mut SessionInput,
    output: &SessionOutput,
) -> Result<Negotiated, String> {
    media::video_header(&mut video, context).await?;
    let video_config = media::packet(&mut video, context).await?;
    let profile = media::h264_profile(&video_config)?;
    if let Some(socket) = audio.as_mut() {
        if media::audio_header(socket, context).await? {
            let packet = media::packet(socket, context).await?;
            media::opus_head(&packet)?;
        } else {
            audio = None;
            signaling::status(output, "audio_unavailable").await?;
        }
    }
    let peer = Peer::new(&profile, audio.is_some()).await?;
    let mut video = reader::Reader::new(video);
    let mut audio = audio.map(reader::Reader::new);
    let result = async {
        let offer = tokio::time::timeout(Duration::from_secs(15), checked(context, async {
            let offer = peer.offer();
            tokio::pin!(offer);
            loop {
                tokio::select! {
                    result = &mut offer => break result,
                    packet = video.next(context) => {
                        let packet = packet?;
                        if packet.flags == 2 && media::h264_profile(&packet)? != profile {
                            return Err("H264 profile 协商期间变化".into());
                        }
                    },
                    packet = async { if let Some(reader) = audio.as_mut() { reader.next(context).await } else { std::future::pending().await } } => {
                        let packet = packet?;
                        if packet.flags == 2 { media::opus_head(&packet)?; }
                    },
                }
            }
        })).await.map_err(|_| "WebRTC ICE 收集超时")??;
        signaling::send(output, json!({"version":1,"epoch":1,"type":"offer","sdp":offer})).await?;
        let mut reader = signaling::Reader::new();
        let answer = tokio::time::timeout(Duration::from_secs(30), checked(context, async {
            loop {
                tokio::select! {
                    message = reader.next(input) => {
                        match message? {
                            Some(signaling::Message::Answer { sdp, .. }) => break Ok(sdp),
                            _ => break Err("WebRTC 缺少首个 answer".into()),
                        }
                    },
                    packet = video.next(context) => {
                        let packet = packet?;
                        if packet.flags == 2 && media::h264_profile(&packet)? != profile {
                            return Err("H264 profile 协商期间变化".into());
                        }
                    },
                    packet = async { if let Some(reader) = audio.as_mut() { reader.next(context).await } else { std::future::pending().await } } => {
                        let packet = packet?;
                        if packet.flags == 2 { media::opus_head(&packet)?; }
                    },
                }
            }
        })).await.map_err(|_| "WebRTC answer 等待超时")??;
        checked(context, peer.answer(answer)).await?;
        Ok((video, audio, video_config.data, reader))
    }.await;
    match result {
        Ok((video, audio, video_config, reader)) => Ok((peer, video, audio, video_config, reader)),
        Err(error) => {
            if !peer.close().await {
                return Err("WebRTC 协商后资源清理未确认".into());
            }
            Err(error)
        }
    }
}

async fn pump(
    device: &mut Device,
    open: &Open,
    context: &InvocationContext,
    input: &mut SessionInput,
    output: &SessionOutput,
    peer: &mut Peer,
    session: MediaSession,
) -> Result<(), String> {
    let MediaSession {
        mut video,
        mut audio,
        control,
        config,
        mut reader,
    } = session;
    let (mut control_read, mut control_write) = control.into_split();
    let profile = media::h264_profile(&media::Packet {
        flags: 2,
        pts: 0,
        data: config.clone(),
    })?;
    let mut config = config;
    let mut video_pts = None;
    let mut audio_pts = None;
    let mut control_buffer = [0u8; 8192];
    let mut awaiting_config = false;
    let mut awaiting_key = false;
    let mut eof = false;
    let mut last_reset = tokio::time::Instant::now() - Duration::from_secs(1);
    let cancel = context.cancellation();
    let mut connected = false;
    let connect_deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let video_sender = peer.video_sender.clone();
    let audio_sender = peer.audio_sender.clone();
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(context.deadline().into()) => return Err("直播业务期限已到期".into()),
            _ = cancel.cancelled() => return Err("直播已取消".into()),
            _ = tokio::time::sleep_until(connect_deadline), if !connected => return Err("WebRTC 建连超时".into()),
            _ = peer.control_failed.cancelled() => return Err("WebRTC 控制无效或队列已满".into()),
            state = peer.states.recv() => {
                match state {
                    Some(RTCPeerConnectionState::Connected) if !connected => {
                        connected = true;
                        checked(context, async {
                            control_write.write_all(&Control::ResetVideo {}.encode()?).await.map_err(|_| "设备视频重置失败".to_owned())
                        }).await?;
                        last_reset = tokio::time::Instant::now();
                        awaiting_config = false;
                        awaiting_key = true;
                        signaling::status(output, "streaming").await?;
                    },
                    Some(RTCPeerConnectionState::Failed | RTCPeerConnectionState::Disconnected | RTCPeerConnectionState::Closed) => return Err("WebRTC 连接已断开".into()),
                    None => return Err("WebRTC 状态通道已关闭".into()),
                    _ => {},
                }
            },
            packet = video.next(context) => {
                let mut packet = packet?;
                if packet.flags == 2 {
                    if media::h264_profile(&packet)? != profile {
                        return Err("H264 profile 运行中变化，须重新协商".into());
                    }
                    config = packet.data;
                    awaiting_config = false;
                } else if connected && !awaiting_config {
                    if awaiting_key && packet.flags != 1 { continue; }
                    if packet.flags == 1 {
                        awaiting_key = false;
                        let mut complete = config.clone();
                        complete.extend(packet.data);
                        packet.data = complete;
                    }
                    let duration = media::sample_duration(&mut video_pts, packet.pts, 33_333);
                    checked(context, async {
                        peer.video.write_sample(&webrtc::media::Sample { data: bytes::Bytes::from(packet.data), duration, ..Default::default() })
                            .await.map_err(|_| "WebRTC 视频发送失败".to_owned())
                    }).await?;
                }
            },
            packet = async {
                if let Some(reader) = audio.as_mut() { reader.next(context).await }
                else { std::future::pending().await }
            } => {
                let packet = packet?;
                if packet.flags == 2 { media::opus_head(&packet)?; }
                else if packet.flags != 0 { return Err("Opus 媒体包标志无效".into()); }
                else if connected {
                    let duration = media::sample_duration(&mut audio_pts, packet.pts, 20_000);
                    let track = peer.audio.as_ref().ok_or("WebRTC 音频轨道未注册")?;
                    checked(context, async {
                        track.write_sample(&webrtc::media::Sample { data: bytes::Bytes::from(packet.data), duration, ..Default::default() })
                            .await.map_err(|_| "WebRTC 音频发送失败".to_owned())
                    }).await?;
                }
            },
            drained = control_read.read(&mut control_buffer) => {
                if drained.map_err(|_| "设备控制应答读取失败")? == 0 { return Err("设备控制连接已断开".into()); }
            },
            control_message = peer.controls.recv() => {
                let Some(message) = control_message else { return Err("WebRTC 控制通道已关闭".into()); };
                let encoded = message?;
                if !open.control { return Err("本次 WebRTC 会话未启用用户控制".into()); }
                checked(context, async { control_write.write_all(&encoded).await.map_err(|_| "设备控制连接已断开".to_owned()) }).await?;
            },
            feedback = video_sender.read_rtcp(), if connected => {
                let (packets, _) = feedback.map_err(|_| "WebRTC RTCP 接收失败")?;
                if packets.iter().any(|packet| {
                    packet.as_any().is::<webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication>()
                        || packet.as_any().is::<webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest>()
                }) && last_reset.elapsed() >= Duration::from_secs(1) {
                    checked(context, async {
                        control_write.write_all(&Control::ResetVideo {}.encode()?).await.map_err(|_| "设备视频重置失败".to_owned())
                    }).await?;
                    last_reset = tokio::time::Instant::now();
                    awaiting_config = false;
                    awaiting_key = true;
                }
            },
            feedback = async {
                if let Some(sender) = &audio_sender { sender.read_rtcp().await.map(|_| ()) }
                else { std::future::pending().await }
            }, if connected && audio_sender.is_some() => {
                feedback.map_err(|_| "WebRTC 音频 RTCP 接收失败")?;
            },
            message = reader.next(input), if !eof => {
                match message? {
                    Some(signaling::Message::Control { command, .. }) => {
                        if !open.control { return Err("本次 WebRTC 会话未启用用户控制".into()); }
                        let command: Control = serde_json::from_value(command).map_err(|_| "WebRTC 控制命令无效")?;
                        let encoded = command.encode()?;
                        checked(context, async { control_write.write_all(&encoded).await.map_err(|_| "设备控制连接已断开".to_owned()) }).await?;
                    },
                    Some(signaling::Message::Answer { .. }) => return Err("WebRTC answer 不得重复".into()),
                    None => eof = true,
                }
            },
            chunk = async { device.server.as_mut().ok_or("设备直播服务器缺失")?.recv().await.ok_or("设备直播服务器已退出") } => { chunk?; },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::cleanup_unconfirmed;

    #[test]
    fn failed_peer_cleanup_stays_sticky() {
        assert!(cleanup_unconfirmed("WebRTC 协商后资源清理未确认"));
        assert!(cleanup_unconfirmed("WebRTC 视频轨道失败且资源清理未确认"));
        assert!(!cleanup_unconfirmed("WebRTC 远端协商失败"));
    }
}
