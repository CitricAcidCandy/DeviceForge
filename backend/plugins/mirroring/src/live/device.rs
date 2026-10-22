//! 本次服务器、远端目录和精确转发的资源所有权。
use super::{checked, model::Open};
use crate::config::Config;
use deviceforge_plugin_runtime::InvocationContext;
use deviceforge_tool_process::{
    Environment, ExecutionOptions, StreamOptions, StreamingProcess, ToolCommand, capture,
    spawn_stream,
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
        // mkdir 可能已执行但响应丢失，因此调用前登记待清理的独占目录。
        self.directory_created = true;
        command(
            config,
            &open.device_id,
            vec!["shell".into(), "mkdir".into(), self.directory.clone()],
            context.deadline().into(),
            context.cancellation(),
        )
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
        )
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
        )
        .await?;
        let port = std::str::from_utf8(&output)
            .ok()
            .and_then(|value| value.trim().parse::<u16>().ok())
            .filter(|value| *value != 0)
            .ok_or("ADB未返回有效独占端口")?;
        self.port = Some(port);
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
        self.server = Some(
            spawn_stream(tool, StreamOptions::new(execution), context.cancellation())
                .await
                .map_err(|_| "无法启动设备直播服务器")?,
        );
        let ready = command(
            config,
            &open.device_id,
            vec!["shell".into(), self.ready_script()],
            context.deadline().into(),
            context.cancellation(),
        )
        .await?;
        if ready != b"DFML_READY\n" && ready != b"DFML_READY\r\n" {
            return Err("设备直播套接字未就绪".into());
        }
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
        format!(
            "echo $$ > {dir}/pid && CLASSPATH={dir}/server.jar exec app_process / com.genymobile.scrcpy.Server {version} scid={scid} tunnel_forward=true video={video} video_bit_rate={rate} audio={audio}{audio_codec} max_size={size} max_fps={fps} control={control} clipboard_autosync={clipboard}{encoder} send_device_meta=false send_dummy_byte=false cleanup=false",
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
    pub(crate) fn cleanup_script(&self) -> String {
        // PID 与命令行身份精确匹配；PID 复用或无法核对时拒绝杀其他进程。
        let await_pid = if self.server_attempted {
            format!(
                "i=0; while [ ! -f {dir}/pid ]; do i=$((i+1)); [ $i -le 10 ] || exit 77; sleep 0.05; done; ",
                dir = self.directory
            )
        } else {
            String::new()
        };
        let identity = self.pid_identity_script();
        format!(
            "{await_pid}if [ -f {dir}/pid ]; then p=$(cat {dir}/pid); case $p in ''|*[!0-9]*) exit 71;; esac; if [ -e /proc/$p ]; then {identity} || exit 72; kill -TERM $p || exit 73; i=0; while kill -0 $p 2>/dev/null; do i=$((i+1)); [ $i -le 20 ] || exit 74; sleep 0.05; done; fi; fi; rm -rf {dir} || exit 75; [ ! -e {dir} ] || exit 76; echo DFML_CLEAN",
            dir = self.directory,
            identity = identity
        )
    }
    pub(crate) async fn cleanup(&mut self, config: &Config, open: &Open) -> bool {
        let mut complete = !self.unresolved;
        let mut owned_port = None;
        if let Some(server) = self.server.as_mut() {
            server.cancel();
            if server.wait().await.is_err_and(|error| {
                matches!(error, deviceforge_tool_process::Error::CleanupFailed { .. })
            }) {
                complete = false;
            }
        }
        self.server = None;
        // 直接进程已有独立的回收上限；远端清理不复用已被退出等待消耗的预算。
        // 后续全部远端命令共享本阶段绝对期限，不能逐条续期。
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        if self.directory_created {
            let result = command(
                config,
                &open.device_id,
                vec!["shell".into(), self.cleanup_script()],
                deadline,
                tokio_util::sync::CancellationToken::new(),
            )
            .await;
            if !matches!(result,Ok(ref output) if output==b"DFML_CLEAN\n" || output==b"DFML_CLEAN\r\n")
            {
                complete = false;
            }
        }
        // 删除前精确核对归属；原端口已被别人复用时不得删除其映射。
        if self.forward_attempted {
            let result = command(
                config,
                &open.device_id,
                vec!["forward".into(), "--list".into()],
                deadline,
                tokio_util::sync::CancellationToken::new(),
            )
            .await;
            match result.and_then(|output| {
                cleanup_forward_port(&output, &open.device_id, &self.scid, self.port)
            }) {
                Ok(Some(port)) if self.port.is_none() || self.port == Some(port) => {
                    self.port = Some(port);
                    owned_port = Some(port);
                }
                Ok(None) => self.port = None,
                Ok(Some(_)) => {
                    complete = false;
                }
                Err(_) => complete = false,
            }
        }
        if let Some(port) = owned_port {
            if command(
                config,
                &open.device_id,
                vec!["forward".into(), "--remove".into(), format!("tcp:{port}")],
                deadline,
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .is_err()
            {
                complete = false;
            } else {
                let result = command(
                    config,
                    &open.device_id,
                    vec!["forward".into(), "--list".into()],
                    deadline,
                    tokio_util::sync::CancellationToken::new(),
                )
                .await;
                if !matches!(
                    result.and_then(|output| forward_port(&output, &open.device_id, &self.scid)),
                    Ok(None)
                ) {
                    complete = false;
                }
            }
        }
        self.unresolved = !complete;
        complete
    }
}
async fn command(
    config: &Config,
    device: &str,
    args: Vec<String>,
    deadline: tokio::time::Instant,
    cancel: tokio_util::sync::CancellationToken,
) -> Result<Vec<u8>, String> {
    let mut argv = vec!["-s".into(), device.into()];
    argv.extend(args);
    let mut tool = ToolCommand::new(&config.adb, &argv);
    tool.environment = Environment::Restricted;
    let mut options = ExecutionOptions::new(deadline);
    options.stdout_limit = 8192;
    options.stderr_limit = 8192;
    capture(tool, options, cancel)
        .await
        .map(|output| output.stdout)
        .map_err(|error| {
            if matches!(error, deviceforge_tool_process::Error::CleanupFailed { .. }) {
                "ADB直播直接进程清理未确认".into()
            } else {
                "ADB直播资源操作失败".into()
            }
        })
}
fn forward_port(output: &[u8], device: &str, scid: &str) -> Result<Option<u16>, String> {
    let text = std::str::from_utf8(output).map_err(|_| "ADB转发清单无效")?;
    let remote = format!("localabstract:scrcpy_{scid}");
    let mut port = None;
    for line in text.lines() {
        let fields: Vec<_> = line.split_ascii_whitespace().collect();
        if fields.len() == 3 && fields[0] == device && fields[2] == remote {
            let parsed = fields[1]
                .strip_prefix("tcp:")
                .and_then(|value| value.parse::<u16>().ok())
                .filter(|value| *value != 0)
                .ok_or("ADB转发端口无效")?;
            if port.replace(parsed).is_some() {
                return Err("ADB独占转发归属冲突".into());
            }
        }
    }
    Ok(port)
}

fn cleanup_forward_port(
    output: &[u8],
    device: &str,
    scid: &str,
    expected: Option<u16>,
) -> Result<Option<u16>, String> {
    let owned = forward_port(output, device, scid)?;
    if let Some(expected) = expected {
        let text = std::str::from_utf8(output).map_err(|_| "ADB转发清单无效")?;
        let local = format!("tcp:{expected}");
        let remote = format!("localabstract:scrcpy_{scid}");
        for line in text.lines().filter(|line| !line.trim().is_empty()) {
            let fields: Vec<_> = line.split_ascii_whitespace().collect();
            if fields.len() != 3 {
                return Err("ADB转发清单无效".into());
            }
            // 本地 TCP 端口属于 ADB 全局映射，其他设备复用也不得删除或宣称确认。
            if fields[1] == local && (fields[0] != device || fields[2] != remote) {
                return Err("ADB独占转发端口已被其他归属使用".into());
            }
        }
        if owned.is_some_and(|port| port != expected) {
            return Err("ADB独占转发端口与原归属不符".into());
        }
    }
    Ok(owned)
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
    fn unique_resource_names_and_private_cleanup() {
        let first = Device::new();
        let second = Device::new();
        assert_ne!(first.directory, second.directory);
        assert!(first.directory.starts_with("/data/local/tmp/deviceforge_"));
        let script = first.cleanup_script();
        assert!(script.contains(&format!("grep -Fxq scid={}", first.scid)));
        assert!(script.contains("grep -Fxq com.genymobile.scrcpy.Server"));
        assert!(script.contains("|| exit 72"));
        assert!(!script.contains("pkill"));
        assert!(!script.contains("kill-server"));
    }
    #[test]
    fn lost_forward_reply_requires_exact_owner() {
        assert_eq!(
            forward_port(
                b"other tcp:8 localabstract:scrcpy_1234\ndemo tcp:42 localabstract:scrcpy_1234\n",
                "demo",
                "1234"
            )
            .unwrap(),
            Some(42)
        );
        assert!(
            forward_port(
                b"demo tcp:42 localabstract:scrcpy_1234\ndemo tcp:43 localabstract:scrcpy_1234\n",
                "demo",
                "1234"
            )
            .is_err()
        );
        assert_eq!(forward_port(b"", "demo", "1234").unwrap(), None);
    }
    #[test]
    fn reused_known_port_never_confirms_or_deletes_foreign_forward() {
        assert!(
            cleanup_forward_port(
                b"demo tcp:42 localabstract:foreign\n",
                "demo",
                "1234",
                Some(42)
            )
            .is_err()
        );
        assert!(
            cleanup_forward_port(
                b"other tcp:42 localabstract:scrcpy_1234\n",
                "demo",
                "1234",
                Some(42)
            )
            .is_err()
        );
        assert!(
            cleanup_forward_port(
                b"demo tcp:43 localabstract:scrcpy_1234\n",
                "demo",
                "1234",
                Some(42)
            )
            .is_err()
        );
        assert_eq!(
            cleanup_forward_port(
                b"demo tcp:42 localabstract:scrcpy_1234\n",
                "demo",
                "1234",
                Some(42)
            )
            .unwrap(),
            Some(42)
        );
        assert_eq!(
            cleanup_forward_port(
                b"other tcp:43 localabstract:foreign\n",
                "demo",
                "1234",
                Some(42)
            )
            .unwrap(),
            None
        );
        assert_eq!(
            cleanup_forward_port(b"", "demo", "1234", Some(42)).unwrap(),
            None
        );
    }

    #[test]
    fn attempted_server_without_pid_is_never_claimed_clean() {
        let mut device = Device::new();
        assert!(!device.cleanup_script().contains("exit 77"));
        device.server_attempted = true;
        let script = device.cleanup_script();
        assert!(script.starts_with("i=0; while [ ! -f "));
        assert!(script.contains("[ $i -le 10 ] || exit 77"));
        assert!(script.find("exit 77").unwrap() < script.find("rm -rf").unwrap());
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
