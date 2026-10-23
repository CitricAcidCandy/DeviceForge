mod cleanup;
mod media;
mod peer;
mod reader;
mod signaling;

use super::{
    checked,
    device::Device,
    device_messages::{self, CLIPBOARD_TEXT_LIMIT, DeviceMessage},
    model::{Control, Open},
    owned_control::OwnedControl,
    ownership::View,
};
use crate::config::Config;
use apk_plugin_sdk::cooperative::CleanupOutcome;
use deviceforge_plugin_runtime::{
    Execution, InvocationContext,
    session::{SessionInput, SessionOutput},
};
use peer::Peer;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use webrtc::data_channel::{RTCDataChannel, data_channel_state::RTCDataChannelState};
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;

pub(super) async fn run(
    mut open: Open,
    config: Config,
    context: InvocationContext,
    mut input: SessionInput,
    output: SessionOutput,
    client_id: String,
    master: bool,
) -> Execution {
    open.reconnect_attempts = 0;
    open.audio = false;
    let mut controller = match OwnedControl::new(&open, &client_id, master, &config).await {
        Ok(controller) => controller,
        Err(error) => return Execution::complete(Err(error)),
    };
    let mut device = Device::new();
    let mut peer = None;
    let mut unresolved = false;
    let mut prepared = open.clone();
    prepared.control = true;
    prepared.clipboard_autosync = false;
    let result = async {
        signaling::status(&output, "connecting").await?;
        controller.refresh(&context).await?;
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
            &mut controller,
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
    // 三类资源归属独立，同时回收，避免串行叠加超过宿主的合作清理窗口。
    let (peer_clean, device_clean, control_clean) = tokio::join!(
        async {
            if let Some(peer) = &peer {
                peer.close().await
            } else {
                true
            }
        },
        device.cleanup(&config, &prepared),
        controller.close(),
    );
    if let Some(error) = cleanup::failure(
        result.as_ref().err().map(String::as_str),
        unresolved,
        peer_clean,
        device_clean,
        control_clean,
    ) {
        return Execution {
            outcome: Err(error),
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
    controller: &mut OwnedControl<'_>,
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
    let mut device_messages = device_messages::Decoder::new();
    let mut clipboard_sequence = 0_u32;
    let mut ownership_revision = 0_u64;
    let mut ownership_tick = tokio::time::interval(Duration::from_millis(100));
    ownership_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
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
                let count = drained.map_err(|_| "设备控制应答读取失败")?;
                if count == 0 {
                    device_messages.finish()?;
                    return Err("设备控制连接已断开".into());
                }
                for message in device_messages.push(&control_buffer[..count])? {
                    match message {
                        DeviceMessage::ClipboardAck(sequence) => {
                            let _ = sequence;
                        }
                        DeviceMessage::Clipboard(_) | DeviceMessage::Uhid => {}
                    }
                }
            },
            _ = ownership_tick.tick() => {
                let view = controller.refresh(context).await?;
                if peer.channel.ready_state() == RTCDataChannelState::Open && view.revision != ownership_revision {
                    send_ownership(&peer.channel, &view, context).await?;
                    ownership_revision = view.revision;
                }
            },
            messages = controller.next() => {
                for message in messages? {
                    if let DeviceMessage::Clipboard(text) = message {
                        let guard = controller.clipboard_guard().await?;
                        if !guard.is_owner() || !controller.clipboard_enabled() || !connected {
                            continue;
                        }
                        let view = guard.view();
                        if peer.channel.ready_state() != RTCDataChannelState::Open { continue; }
                        if ownership_revision != view.revision {
                            send_ownership(&peer.channel, &view, context).await?;
                            ownership_revision = view.revision;
                        }
                        clipboard_sequence = clipboard_sequence.checked_add(1).ok_or("设备剪贴板序号耗尽")?;
                        send_clipboard(&peer.channel, &text, clipboard_sequence, view.control_revision, context).await?;
                    }
                }
            },
            control_message = peer.controls.recv() => {
                let Some(message) = control_message else { return Err("WebRTC 控制通道已关闭".into()); };
                match message? {
                    signaling::EncodedControl::Input { bytes, revision } if bytes == [17] => {
                        let _ = revision;
                        checked(context, async { control_write.write_all(&bytes).await.map_err(|_| "设备视频重置失败".to_owned()) }).await?;
                    },
                    signaling::EncodedControl::Input { bytes, revision } => {
                        controller.send(&bytes, revision, context).await?;
                    },
                    signaling::EncodedControl::Ownership { request_id, command } => {
                        ownership_result(controller, &peer.channel, request_id, command, context).await?;
                    },
                }
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
                    Some(signaling::Message::Control { command, control_revision, .. }) => {
                        let command: Control = serde_json::from_value(command).map_err(|_| "WebRTC 控制命令无效")?;
                        let encoded = command.encode()?;
                        if encoded == [17] {
                            checked(context, async { control_write.write_all(&encoded).await.map_err(|_| "设备视频重置失败".to_owned()) }).await?;
                        } else {
                            controller.send(&encoded, control_revision, context).await?;
                        }
                    },
                    Some(message @ (signaling::Message::ControlRequest { .. }
                        | signaling::Message::ControlRespond { .. }
                        | signaling::Message::ControlReclaim { .. }
                        | signaling::Message::ControlRelease { .. })) => {
                        let (request_id, command) = signaling::ownership(message)?;
                        ownership_result(controller, &peer.channel, request_id, command, context).await?;
                    },
                    Some(signaling::Message::Answer { .. }) => return Err("WebRTC answer 不得重复".into()),
                    None => eof = true,
                }
            },
            chunk = async { device.server.as_mut().ok_or("设备直播服务器缺失")?.recv().await.ok_or("设备直播服务器已退出") } => { chunk?; },
        }
    }
}

fn clipboard_parts(text: &str) -> Result<Vec<String>, String> {
    if text.len() > CLIPBOARD_TEXT_LIMIT {
        return Err("设备剪贴板消息超限".into());
    }
    if text.is_empty() {
        return Ok(vec![String::new()]);
    }
    let mut parts = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = start;
        for (offset, character) in text[start..].char_indices() {
            let next = start + offset + character.len_utf8();
            if next - start > 8192 {
                break;
            }
            end = next;
        }
        if end == start {
            return Err("设备剪贴板分片无效".into());
        }
        parts.push(text[start..end].to_owned());
        start = end;
    }
    if parts.len() > 33 {
        return Err("设备剪贴板分片超限".into());
    }
    Ok(parts)
}

async fn ownership_result(
    controller: &OwnedControl<'_>,
    channel: &Arc<RTCDataChannel>,
    request_id: String,
    command: crate::live::ownership::Command,
    context: &InvocationContext,
) -> Result<(), String> {
    let result = controller.command(command).await;
    if let Ok(view) = &result {
        send_ownership(channel, view, context).await?;
    }
    let payload = match result {
        Ok(_) => {
            json!({"version":1,"epoch":1,"type":"control_result","request_id":request_id,"ok":true})
        }
        Err(error) => {
            json!({"version":1,"epoch":1,"type":"control_result","request_id":request_id,"ok":false,"error":error})
        }
    };
    let payload = serde_json::to_string(&payload).map_err(|_| "控制权回执编码失败")?;
    checked(context, async {
        tokio::time::timeout(Duration::from_secs(1), channel.send_text(payload))
            .await
            .map_err(|_| "控制权回执发送超时")?
            .map_err(|_| "控制权回执发送失败".to_owned())?;
        Ok(())
    })
    .await
}

async fn send_ownership(
    channel: &Arc<RTCDataChannel>,
    view: &View,
    context: &InvocationContext,
) -> Result<(), String> {
    let payload = serde_json::to_string(view).map_err(|_| "设备控制权状态编码失败")?;
    checked(context, async {
        tokio::time::timeout(Duration::from_secs(1), channel.send_text(payload))
            .await
            .map_err(|_| "设备控制权状态发送超时")?
            .map_err(|_| "设备控制权状态发送失败".to_owned())?;
        Ok(())
    })
    .await
}

async fn send_clipboard(
    channel: &Arc<RTCDataChannel>,
    text: &str,
    sequence: u32,
    revision: u64,
    context: &InvocationContext,
) -> Result<(), String> {
    let parts = clipboard_parts(text)?;
    let total = parts.len();
    let until = tokio::time::Instant::now() + Duration::from_secs(2);
    for (part, text) in parts.into_iter().enumerate() {
        let payload = serde_json::to_string(&json!({
            "version": 1,
            "type": "clipboard",
            "epoch": 1,
            "sequence": sequence,
            "control_revision": revision,
            "part": part,
            "total": total,
            "text": text,
        }))
        .map_err(|_| "设备剪贴板消息编码失败")?;
        checked(context, async move {
            loop {
                if channel.ready_state() != RTCDataChannelState::Open {
                    return Err("WebRTC 控制通道未连接".into());
                }
                if channel.buffered_amount().await <= 256 * 1024 {
                    break;
                }
                if tokio::time::Instant::now() >= until {
                    return Err("WebRTC 剪贴板发送超时".into());
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            tokio::time::timeout_at(until, channel.send_text(payload))
                .await
                .map_err(|_| "WebRTC 剪贴板发送超时")?
                .map_err(|_| "WebRTC 剪贴板发送失败".to_owned())?;
            Ok(())
        })
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{cleanup_unconfirmed, clipboard_parts};
    use crate::live::device_messages::CLIPBOARD_TEXT_LIMIT;

    #[test]
    fn failed_peer_cleanup_stays_sticky() {
        assert!(cleanup_unconfirmed("WebRTC 协商后资源清理未确认"));
        assert!(cleanup_unconfirmed("WebRTC 视频轨道失败且资源清理未确认"));
        assert!(!cleanup_unconfirmed("WebRTC 远端协商失败"));
    }

    #[test]
    fn clipboard_parts_preserve_utf8_and_bounds() {
        let text = "中".repeat(80_000);
        let parts = clipboard_parts(&text).unwrap();
        assert!(parts.len() <= 33);
        assert!(parts.iter().all(|part| part.len() <= 8192));
        assert_eq!(parts.concat(), text);
        assert_eq!(clipboard_parts("").unwrap(), vec![String::new()]);
        assert!(clipboard_parts(&"x".repeat(CLIPBOARD_TEXT_LIMIT + 1)).is_err());
    }
}
