//! 本次服务器、远端目录和精确转发的资源所有权。
mod cleanup;
mod journal;

use super::{checked, model::Open};
use crate::{
    config::Config,
    recovery::{self, Ledger, Stage},
};
use deviceforge_plugin_runtime::InvocationContext;
use deviceforge_tool_process::{
    Environment, ExecutionOptions, StreamOptions, StreamingProcess, ToolCommand,
    capture_with_lease, spawn_stream_with_lease,
};
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::net::TcpStream;
static NEXT: AtomicU64 = AtomicU64::new(1);
pub(crate) struct Device {
    server_version: &'static str,
    pub directory: String,
    pub scid: String,
    pub port: Option<u16>,
    pub forward_attempted: bool,
    pub directory_created: bool,
    pub server_attempted: bool,
    pub server: Option<StreamingProcess>,
    pub unresolved: bool,
    ledger: Option<Ledger>,
}
impl Device {
    pub(crate) fn new() -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let ordinal = NEXT.fetch_add(1, Ordering::Relaxed);
        let value = timestamp ^ u128::from(std::process::id()) ^ u128::from(ordinal);
        // 拼接时间、进程与序号，避免异或值被当作完整所有权身份。
        let nonce = format!(
            "{:016x}{:08x}{:08x}",
            timestamp as u64,
            std::process::id(),
            ordinal as u32
        );
        Self {
            server_version: "3.3.1",
            directory: format!("/data/local/tmp/deviceforge_{nonce}"),
            scid: format!("{:08x}", ((value as u32) & 0x7fff_ffff).max(1)),
            port: None,
            forward_attempted: false,
            directory_created: false,
            server_attempted: false,
            server: None,
            unresolved: false,
            ledger: None,
        }
    }
    pub(crate) async fn prepare(
        &mut self,
        config: &Config,
        open: &Open,
        context: &InvocationContext,
    ) -> Result<(), String> {
        self.prepare_with_audio_codec(config, open, context, "raw")
            .await
    }
    pub(crate) async fn prepare_with_audio_codec(
        &mut self,
        config: &Config,
        open: &Open,
        context: &InvocationContext,
        audio_codec: &str,
    ) -> Result<(), String> {
        self.prepare_mode(config, open, context, audio_codec, true)
            .await
    }
    pub(crate) async fn prepare_control(
        &mut self,
        config: &Config,
        open: &Open,
        context: &InvocationContext,
    ) -> Result<(), String> {
        self.prepare_mode(config, open, context, "raw", false).await
    }
    async fn prepare_mode(
        &mut self,
        config: &Config,
        open: &Open,
        context: &InvocationContext,
        audio_codec: &str,
        video: bool,
    ) -> Result<(), String> {
        let live = config.live.as_ref().ok_or("未配置直播服务器")?;
        // 在创建资源前固定本次版本，启动、就绪及清理始终核对同一进程身份。
        self.server_version = crate::config::server_version(&live.server_version)
            .ok_or("直播服务版本须为3.3.1或3.3.4")?;
        let meta = checked(context, async {
            tokio::fs::symlink_metadata(&live.scrcpy_server)
                .await
                .map_err(|_| "无法读取直播服务文件".to_owned())
        })
        .await?;
        if !meta.is_file()
            || meta.file_type().is_symlink()
            || meta.len() == 0
            || meta.len() > 64 * 1024 * 1024
        {
            return Err("直播服务文件无效或超限".into());
        }
        // 台账原子发布成功之前不允许任何 ADB 副作用。
        self.ledger = Some(
            recovery::new_record(
                &open.device_id,
                &self.directory,
                &self.scid,
                self.server_version,
            )
            .await?,
        );
        self.stage(journal::Resource::Directory, Stage::Attempting)
            .await?;
        self.directory_created = true;
        command(
            config,
            &open.device_id,
            vec![
                "shell".into(),
                recovery::remote::create(&self.ledger.as_ref().ok_or("资源台账缺失")?.record),
            ],
            context.deadline().into(),
            context.cancellation(),
            self.tool_lease(),
        )
        .await?;
        self.stage(journal::Resource::Directory, Stage::Confirmed)
            .await?;
        self.stage(journal::Resource::Upload, Stage::Attempting)
            .await?;
        command(
            config,
            &open.device_id,
            vec![
                "push".into(),
                live.scrcpy_server
                    .to_str()
                    .ok_or("服务文件路径不是UTF-8")?
                    .into(),
                format!("{}/server.jar", self.directory),
            ],
            context.deadline().into(),
            context.cancellation(),
            self.tool_lease(),
        )
        .await?;
        self.stage(journal::Resource::Upload, Stage::Confirmed)
            .await?;
        self.stage(journal::Resource::Forward, Stage::Attempting)
            .await?;
        self.forward_attempted = true;
        let output = command(
            config,
            &open.device_id,
            vec![
                "forward".into(),
                "--no-rebind".into(),
                "tcp:0".into(),
                format!("localabstract:scrcpy_{}", self.scid),
            ],
            context.deadline().into(),
            context.cancellation(),
            self.tool_lease(),
        )
        .await?;
        let port = std::str::from_utf8(&output)
            .ok()
            .and_then(|value| value.trim().parse::<u16>().ok())
            .filter(|value| *value != 0)
            .ok_or("ADB未返回有效独占端口")?;
        self.port = Some(port);
        self.stage(journal::Resource::Forward, Stage::Confirmed)
            .await?;
        let args = vec![
            "-s".into(),
            open.device_id.clone(),
            "shell".into(),
            if !video {
                self.script_mode(open, live.video_encoder.as_deref(), audio_codec, false)
            } else if audio_codec == "raw" {
                self.script(open, live.video_encoder.as_deref())
            } else {
                self.script_with_audio_codec(open, live.video_encoder.as_deref(), audio_codec)
            },
        ];
        let mut tool = ToolCommand::new(&config.adb, &args);
        tool.environment = Environment::Restricted;
        let mut execution = ExecutionOptions::new(context.deadline().into());
        execution.stdout_limit = 1024 * 1024;
        execution.stderr_limit = 1024 * 1024;
        self.server_attempted = true;
        self.stage(journal::Resource::Server, Stage::Attempting)
            .await?;
        self.server = Some(
            spawn_stream_with_lease(
                tool,
                StreamOptions::new(execution),
                context.cancellation(),
                self.tool_lease().ok_or("资源台账租约缺失")?,
            )
            .await
            .map_err(|_| "无法启动设备直播服务器")?,
        );
        let ready = command(
            config,
            &open.device_id,
            vec!["shell".into(), self.ready_script()],
            context.deadline().into(),
            context.cancellation(),
            self.tool_lease(),
        )
        .await?;
        if ready != b"DFML_READY\n" && ready != b"DFML_READY\r\n" {
            return Err("设备直播套接字未就绪".into());
        }
        let record = &self.ledger.as_ref().ok_or("资源台账缺失")?.record;
        let receipt = command(
            config,
            &open.device_id,
            vec!["shell".into(), recovery::remote::receipt(record)],
            context.deadline().into(),
            context.cancellation(),
            self.tool_lease(),
        )
        .await?;
        let identity = recovery::remote::parse_identity(&receipt, record)?;
        self.ledger.as_mut().ok_or("资源台账缺失")?.record.remote = Some(identity);
        self.stage(journal::Resource::Server, Stage::Confirmed)
            .await?;
        Ok(())
    }
    pub(crate) fn script(&self, open: &Open, video_encoder: Option<&str>) -> String {
        self.script_with_audio_codec(open, video_encoder, "raw")
    }
    fn script_with_audio_codec(
        &self,
        open: &Open,
        video_encoder: Option<&str>,
        codec: &str,
    ) -> String {
        self.script_mode(open, video_encoder, codec, true)
    }
    fn script_mode(
        &self,
        open: &Open,
        video_encoder: Option<&str>,
        codec: &str,
        video: bool,
    ) -> String {
        let encoder = video_encoder
            .map(|name| format!(" video_encoder={name}"))
            .unwrap_or_default();
        let audio_codec = if open.audio {
            format!(" audio_codec={codec}")
        } else {
            String::new()
        };
        let prefix = self
            .ledger
            .as_ref()
            .map(|ledger| recovery::remote::launch_prefix(&ledger.record))
            .unwrap_or_else(|| format!("echo $$ > {}/pid && ", self.directory));
        format!(
            "{prefix}CLASSPATH={dir}/server.jar exec app_process / com.genymobile.scrcpy.Server {version} scid={scid} tunnel_forward=true video={video} video_bit_rate={rate} audio={audio}{audio_codec} max_size={size} max_fps={fps} control={control} clipboard_autosync={clipboard}{encoder} send_device_meta=false send_dummy_byte=false cleanup=false",
            dir = self.directory,
            version = self.server_version,
            scid = self.scid,
            audio = open.audio,
            control = open.control,
            size = open.max_size,
            fps = open.max_fps,
            rate = open.video_bit_rate,
            encoder = encoder,
            audio_codec = audio_codec,
            clipboard = !video && open.control && open.clipboard_autosync
        )
    }
    fn pid_identity_script(&self) -> String {
        if let Some(ledger) = &self.ledger {
            return recovery::remote::identity(&ledger.record);
        }
        format!(
            "a=$(tr '\\000' '\\n' < /proc/$p/cmdline); n=$(printf '%s\\n' \"$a\" | head -n 1); [ \"$n\" = app_process ] && printf '%s\\n' \"$a\" | grep -Fxq com.genymobile.scrcpy.Server && printf '%s\\n' \"$a\" | grep -Fxq {version} && printf '%s\\n' \"$a\" | grep -Fxq scid={scid} && printf '%s\\n' \"$a\" | grep -Fxq tunnel_forward=true",
            version = self.server_version,
            scid = self.scid
        )
    }
    pub(crate) fn ready_script(&self) -> String {
        // 本地 ADB 转发端口可先于远端服务接入，须等待本次进程和套接字同时就绪。
        let identity = self.pid_identity_script();
        format!(
            "i=0; while [ $i -lt 100 ]; do if [ -f {dir}/pid ]; then p=$(cat {dir}/pid); case $p in ''|*[!0-9]*) exit 71;; esac; if [ -e /proc/$p ]; then if {identity} && grep -q ' @scrcpy_{scid}$' /proc/net/unix; then echo DFML_READY; exit 0; fi; fi; fi; i=$((i+1)); sleep 0.05; done; exit 78",
            dir = self.directory,
            identity = identity,
            scid = self.scid
        )
    }
    pub(crate) async fn connect(&self, context: &InvocationContext) -> Result<TcpStream, String> {
        let port = self.port.ok_or("直播端口尚未分配")?;
        checked(context, async {
            // 三路建立各自最多五秒，始终受原业务截止点约束。
            let until = tokio::time::Instant::now() + Duration::from_secs(5);
            loop {
                match TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await {
                    Ok(socket) => {
                        socket.set_nodelay(true).map_err(|_| "无法配置直播连接")?;
                        return Ok(socket);
                    }
                    Err(_) if tokio::time::Instant::now() < until => {
                        tokio::time::sleep(Duration::from_millis(25)).await
                    }
                    Err(_) => return Err("无法连接设备直播端口".into()),
                }
            }
        })
        .await
    }
}
async fn command(
    config: &Config,
    device: &str,
    args: Vec<String>,
    deadline: tokio::time::Instant,
    cancel: tokio_util::sync::CancellationToken,
    lease: Option<std::sync::Arc<recovery::ledger::ToolLease>>,
) -> Result<Vec<u8>, String> {
    command_result(config, device, args, deadline, cancel, lease)
        .await
        .map_err(|error| {
            if matches!(error, deviceforge_tool_process::Error::CleanupFailed { .. }) {
                "ADB直播直接进程清理未确认".into()
            } else {
                "ADB直播资源操作失败".into()
            }
        })
}

async fn command_result(
    config: &Config,
    device: &str,
    args: Vec<String>,
    deadline: tokio::time::Instant,
    cancel: tokio_util::sync::CancellationToken,
    lease: Option<std::sync::Arc<recovery::ledger::ToolLease>>,
) -> Result<Vec<u8>, deviceforge_tool_process::Error> {
    let mut argv = vec!["-s".into(), device.into()];
    argv.extend(args);
    let mut tool = ToolCommand::new(&config.adb, &argv);
    tool.environment = Environment::Restricted;
    let mut options = ExecutionOptions::new(deadline);
    options.stdout_limit = 8192;
    options.stderr_limit = 8192;
    if let Some(lease) = lease {
        capture_with_lease(tool, options, cancel, lease)
            .await
            .map(|output| output.stdout)
    } else {
        let lease = recovery::process_lease(true)
            .await
            .map_err(|error| {
                deviceforge_tool_process::Error::ProcessIo(std::io::Error::other(error))
            })?
            .ok_or_else(|| {
                deviceforge_tool_process::Error::ProcessIo(std::io::Error::other("插件正在恢复"))
            })?;
        capture_with_lease(tool, options, cancel, lease)
            .await
            .map(|output| output.stdout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn qualified_version_is_shared_by_start_readiness_and_cleanup() {
        let open: Open = serde_json::from_str(r#"{"device_id":"demo"}"#).unwrap();
        for version in ["3.3.1", "3.3.4"] {
            let mut device = Device::new();
            device.server_version = crate::config::server_version(version).unwrap();
            assert!(device.script(&open, None).contains(&format!(
                "com.genymobile.scrcpy.Server {version} scid={} ",
                device.scid
            )));
            assert!(
                device
                    .script_mode(&open, None, "raw", false)
                    .contains(&format!("com.genymobile.scrcpy.Server {version} "))
            );
            for script in [device.ready_script(), device.cleanup_script()] {
                assert!(script.contains(&format!("grep -Fxq {version} &&")));
                assert!(script.contains(&format!("grep -Fxq scid={} &&", device.scid)));
            }
        }
    }

    #[test]
    fn readiness_requires_owned_process_and_socket() {
        let device = Device::new();
        let script = device.ready_script();
        assert!(script.contains(&format!("{}/pid", device.directory)));
        assert!(script.contains(&format!("grep -Fxq scid={}", device.scid)));
        assert!(script.contains("grep -Fxq com.genymobile.scrcpy.Server"));
        assert!(script.contains(&format!(" @scrcpy_{}$", device.scid)));
        assert!(script.contains("exit 78"));
    }
    #[test]
    fn deployment_encoder_is_fixed_in_server_command() {
        let device = Device::new();
        let open: Open = serde_json::from_str(r#"{"device_id":"demo"}"#).unwrap();
        assert!(
            device
                .script(&open, Some("c2.android.avc.encoder"))
                .contains(" video_encoder=c2.android.avc.encoder ")
        );
        assert!(!device.script(&open, None).contains(" video_encoder="));
        assert!(!device.script(&open, None).contains("--nice-name"));
        assert!(!device.script(&open, None).contains("power_on=false"));
        assert!(device.script(&open, None).contains(" audio_codec=raw"));
        assert!(
            device
                .script(&open, None)
                .contains(" clipboard_autosync=false")
        );
        let synced: Open =
            serde_json::from_str(r#"{"device_id":"demo","clipboard_autosync":true}"#).unwrap();
        assert!(
            device
                .script(&synced, None)
                .contains(" clipboard_autosync=false")
        );
        let silent: Open = serde_json::from_str(r#"{"device_id":"demo","audio":false}"#).unwrap();
        assert!(!device.script(&silent, None).contains(" audio_codec="));
        let control_off: Open = serde_json::from_str(
            r#"{"device_id":"demo","control":false,"clipboard_autosync":true}"#,
        )
        .unwrap();
        assert!(
            device
                .script(&control_off, None)
                .contains(" clipboard_autosync=false")
        );
    }
}
