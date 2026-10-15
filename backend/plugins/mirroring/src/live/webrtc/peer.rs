use std::{sync::Arc, time::Duration};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use webrtc::{
    api::{
        APIBuilder,
        interceptor_registry::register_default_interceptors,
        media_engine::{MIME_TYPE_H264, MIME_TYPE_OPUS, MediaEngine},
    },
    data_channel::data_channel_init::RTCDataChannelInit,
    peer_connection::{
        RTCPeerConnection, configuration::RTCConfiguration,
        peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription,
    },
    rtp_transceiver::{
        RTCPFeedback,
        rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType},
    },
    track::track_local::track_local_static_sample::TrackLocalStaticSample,
};

pub(super) struct Peer {
    pub connection: Arc<RTCPeerConnection>,
    pub video: Arc<TrackLocalStaticSample>,
    pub audio: Option<Arc<TrackLocalStaticSample>>,
    pub(crate) states: mpsc::Receiver<RTCPeerConnectionState>,
    pub video_sender: Arc<webrtc::rtp_transceiver::rtp_sender::RTCRtpSender>,
    pub audio_sender: Option<Arc<webrtc::rtp_transceiver::rtp_sender::RTCRtpSender>>,
    pub controls: mpsc::Receiver<Result<Vec<u8>, String>>,
    pub control_failed: CancellationToken,
}

impl Peer {
    pub(super) async fn new(profile: &str, audio: bool) -> Result<Self, String> {
        let mut engine = MediaEngine::default();
        engine.register_codec(
            RTCRtpCodecParameters {
                capability: RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_H264.into(),
                    clock_rate: 90_000,
                    sdp_fmtp_line: format!(
                        "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id={profile}"
                    ),
                    rtcp_feedback: vec![
                        RTCPFeedback { typ: "nack".into(), parameter: "pli".into() },
                        RTCPFeedback { typ: "ccm".into(), parameter: "fir".into() },
                    ],
                    ..Default::default()
                },
                payload_type: 102,
                ..Default::default()
            },
            RTPCodecType::Video,
        )
        .map_err(|_| "WebRTC H264 编码注册失败")?;
        if audio {
            engine
                .register_codec(
                    RTCRtpCodecParameters {
                        capability: RTCRtpCodecCapability {
                            mime_type: MIME_TYPE_OPUS.into(),
                            clock_rate: 48_000,
                            channels: 2,
                            sdp_fmtp_line: "minptime=10;useinbandfec=1".into(),
                            ..Default::default()
                        },
                        payload_type: 111,
                        ..Default::default()
                    },
                    RTPCodecType::Audio,
                )
                .map_err(|_| "WebRTC Opus 编码注册失败")?;
        }
        let registry = register_default_interceptors(Default::default(), &mut engine)
            .map_err(|_| "WebRTC RTCP 注册失败")?;
        let api = APIBuilder::new()
            .with_media_engine(engine)
            .with_interceptor_registry(registry)
            .build();
        let connection = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .map_err(|_| "WebRTC 连接创建失败")?,
        );
        let (sender, states) = mpsc::channel(8);
        let control_failed = CancellationToken::new();
        let state_failed = control_failed.clone();
        connection.on_peer_connection_state_change(Box::new(move |state| {
            let sender = sender.clone();
            let state_failed = state_failed.clone();
            Box::pin(async move {
                if sender.try_send(state).is_err() {
                    state_failed.cancel();
                }
            })
        }));
        let (control_tx, controls) = mpsc::channel(64);
        let channel = match connection
            .create_data_channel(
                "deviceforge.control",
                Some(RTCDataChannelInit {
                    ordered: Some(true),
                    ..Default::default()
                }),
            )
            .await
        {
            Ok(channel) => channel,
            Err(_) => {
                if !close_connection(&connection).await {
                    return Err("WebRTC 控制通道失败且资源清理未确认".into());
                }
                return Err("WebRTC 控制通道创建失败".into());
            }
        };
        let failed = control_failed.clone();
        channel.on_message(Box::new(move |message| {
            let control_tx = control_tx.clone();
            let failed = failed.clone();
            Box::pin(async move {
                let value = super::signaling::control_line(&message.data);
                if value.is_err() || control_tx.try_send(value).is_err() {
                    failed.cancel();
                }
            })
        }));
        let video = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_H264.into(),
                clock_rate: 90_000,
                sdp_fmtp_line: format!(
                    "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id={profile}"
                ),
                ..Default::default()
            },
            "video".into(),
            "deviceforge".into(),
        ));
        let video_sender = match connection.add_track(video.clone()).await {
            Ok(sender) => sender,
            Err(_) => {
                if !close_connection(&connection).await {
                    return Err("WebRTC 视频轨道失败且资源清理未确认".into());
                }
                return Err("WebRTC 视频轨道注册失败".into());
            }
        };
        let (audio, audio_sender) = if audio {
            let track = Arc::new(TrackLocalStaticSample::new(
                RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_OPUS.into(),
                    clock_rate: 48_000,
                    channels: 2,
                    ..Default::default()
                },
                "audio".into(),
                "deviceforge".into(),
            ));
            let sender = match connection.add_track(track.clone()).await {
                Ok(sender) => sender,
                Err(_) => {
                    if !close_connection(&connection).await {
                        return Err("WebRTC 音频轨道失败且资源清理未确认".into());
                    }
                    return Err("WebRTC 音频轨道注册失败".into());
                }
            };
            (Some(track), Some(sender))
        } else {
            (None, None)
        };
        Ok(Self {
            connection,
            video,
            audio,
            states,
            video_sender,
            audio_sender,
            controls,
            control_failed,
        })
    }

    pub(super) async fn offer(&self) -> Result<String, String> {
        let gathered = self.connection.gathering_complete_promise().await;
        let offer = self
            .connection
            .create_offer(None)
            .await
            .map_err(|_| "WebRTC offer 失败")?;
        self.connection
            .set_local_description(offer)
            .await
            .map_err(|_| "WebRTC 本地协商失败")?;
        let mut gathered = gathered;
        gathered.recv().await;
        let description = self
            .connection
            .local_description()
            .await
            .ok_or("WebRTC offer 缺失")?;
        Ok(description.sdp)
    }

    pub(super) async fn answer(&self, sdp: String) -> Result<(), String> {
        let description =
            RTCSessionDescription::answer(sdp).map_err(|_| "WebRTC answer SDP 无效")?;
        self.connection
            .set_remote_description(description)
            .await
            .map_err(|_| "WebRTC 远端协商失败".to_owned())
    }

    pub(super) async fn close(&self) -> bool {
        close_connection(&self.connection).await
    }
}

async fn close_connection(connection: &RTCPeerConnection) -> bool {
    tokio::time::timeout(Duration::from_secs(2), connection.close())
        .await
        .is_ok_and(|result| result.is_ok())
}
