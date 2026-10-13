//! 采集任务独占scrcpy服务、转发及远端目录；不复用别人会话。
use super::{
    rules::{self, Anchor},
    tools,
};
use crate::{Error, Result, config::profile::Profile, session::Session};
use deviceforge_tool_process::{
    Environment, ExecutionOptions, StreamOptions, StreamingProcess, ToolCommand, spawn_stream,
};
use std::time::Duration;
use tokio::{io::AsyncReadExt, net::TcpStream};
pub(super) struct Device {
    pub directory: String,
    pub nonce: String,
    pub scid: String,
    pub port: Option<u16>,
    pub created: bool,
    pub forwarded: bool,
    pub launched: bool,
    pub server: Option<StreamingProcess>,
}
impl Device {
    pub fn new() -> Self {
        use sha2::{Digest, Sha256};
        let raw = format!(
            "{}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            std::thread::current().id()
        );
        let nonce = format!("{:x}", Sha256::digest(raw.as_bytes()));
        let value = u32::from_str_radix(&nonce[..8], 16).unwrap_or(1) & 0x7fff_ffff;
        Self {
            directory: format!("/data/local/tmp/df_profile_video_{nonce}"),
            nonce,
            scid: format!("{:08x}", value.max(1)),
            port: None,
            created: false,
            forwarded: false,
            launched: false,
            server: None,
        }
    }
    pub async fn prepare(
        &mut self,
        session: &Session,
        device: &str,
        profile: &Profile,
    ) -> Result<()> {
        let jar = profile
            .scrcpy_server
            .as_ref()
            .ok_or(Error::Dependency("未部署scrcpy服务"))?;
        let clock = profile
            .clock_helper
            .as_ref()
            .ok_or(Error::Dependency("未部署设备时钟助手"))?;
        for file in [jar, clock] {
            session
                .work({
                    let path = file.clone();
                    move |check| {
                        check()?;
                        let meta = crate::session::files::regular(&path, false)?;
                        if meta.len() == 0 || meta.len() > 64 * 1024 * 1024 {
                            return Err(Error::TooLarge);
                        }
                        Ok(())
                    }
                })
                .await?;
        }
        self.created = true;
        let out=tools::adb(session,device,tools::script_args(&format!("umask 077; mkdir {dir} && printf '%s\\n' {nonce} > {dir}/owner.token && echo DFPC_VIDEO_CREATED",dir=self.directory,nonce=self.nonce))).await?;
        if out != b"DFPC_VIDEO_CREATED\n" && out != b"DFPC_VIDEO_CREATED\r\n" {
            return Err(Error::Dependency("视频私有目录创建回执无效"));
        }
        for (file, name) in [(jar, "server.jar"), (clock, "clock.jar")] {
            tools::adb(
                session,
                device,
                vec![
                    "push".into(),
                    file.to_str()
                        .ok_or(Error::Invalid("视频部署路径须为UTF-8"))?
                        .into(),
                    format!("{}/{name}", self.directory),
                ],
            )
            .await?;
        }
        self.forwarded = true;
        let raw = tools::adb(
            session,
            device,
            vec![
                "forward".into(),
                "--no-rebind".into(),
                "tcp:0".into(),
                format!("localabstract:scrcpy_{}", self.scid),
            ],
        )
        .await?;
        self.port = Some(
            std::str::from_utf8(&raw)
                .ok()
                .and_then(|s| s.trim().parse::<u16>().ok())
                .filter(|p| *p > 0)
                .ok_or(Error::Dependency("视频独占端口回执无效"))?,
        );
        let arguments = rules::server_arguments(&self.scid)?;
        let script = format!(
            "cat /proc/$$/stat > {dir}/owner.stat && CLASSPATH={dir}/server.jar exec {arguments}",
            dir = self.directory
        );
        let mut args = vec!["-s".into(), device.into()];
        args.extend(tools::script_args(&script));
        let mut cmd = ToolCommand::new(&session.control.executable, &args);
        cmd.environment = Environment::Restricted;
        self.launched = true;
        self.server = Some(
            spawn_stream(
                cmd,
                StreamOptions::new(ExecutionOptions::new(
                    session.control.context.deadline().into(),
                )),
                session.control.context.cancellation(),
            )
            .await
            .map_err(|_| Error::Dependency("scrcpy视频服务启动失败"))?,
        );
        Ok(())
    }
    pub async fn anchor(&self, session: &Session, device: &str) -> Result<Anchor> {
        let text = tools::adb(
            session,
            device,
            tools::script_args(&format!(
                "CLASSPATH={}/clock.jar app_process / com.deviceforge.profile.ClockAnchor",
                self.directory
            )),
        )
        .await?;
        rules::anchor(
            std::str::from_utf8(&text).map_err(|_| Error::Dependency("视频时钟回执不是UTF-8"))?,
        )
    }
    pub async fn connect(&self, session: &Session) -> Result<(TcpStream, [u8; 12])> {
        let port = self.port.ok_or(Error::Dependency("视频转发尚未创建"))?;
        let until = tokio::time::Instant::from_std(session.control.context.deadline())
            .min(tokio::time::Instant::now() + Duration::from_secs(5));
        loop {
            session.control.context.check()?;
            let cancel = session.control.context.cancellation();
            let connected = tokio::select! {biased;_=cancel.cancelled()=>return Err(Error::Cancelled),_=tokio::time::sleep_until(until)=>{session.control.check()?;return Err(Error::Dependency("scrcpy视频连接失败"))},r=TcpStream::connect((std::net::Ipv4Addr::LOCALHOST,port))=>r};
            match connected {
                Ok(mut socket) => {
                    // ADB转发能先接受TCP，远端scrcpy尚未监听时会立即关闭；读完协议头才算就绪。
                    let mut header = [0; 12];
                    let read = tokio::select! {biased;_=cancel.cancelled()=>return Err(Error::Cancelled),_=tokio::time::sleep_until(until)=>{session.control.check()?;return Err(Error::Dependency("scrcpy视频连接失败"))},r=socket.read_exact(&mut header)=>r};
                    match read {
                        Ok(_) => {
                            session.control.check()?;
                            rules::video_dimensions(&header)?;
                            return Ok((socket, header));
                        }
                        Err(_) if tokio::time::Instant::now() < until => {}
                        Err(_) => {
                            session.control.check()?;
                            return Err(Error::Dependency("scrcpy视频连接失败"));
                        }
                    }
                    retry_delay(session, until).await?;
                }
                Err(_) if tokio::time::Instant::now() < until => {
                    retry_delay(session, until).await?
                }
                Err(_) => {
                    session.control.check()?;
                    return Err(Error::Dependency("scrcpy视频连接失败"));
                }
            }
        }
    }
}

async fn retry_delay(session: &Session, until: tokio::time::Instant) -> Result<()> {
    let stop = session.control.context.cancellation();
    let next = until.min(tokio::time::Instant::now() + Duration::from_millis(25));
    tokio::select! {biased;_=stop.cancelled()=>Err(Error::Cancelled),_=tokio::time::sleep_until(next)=>{session.control.check()?;Ok(())}}
}

#[cfg(test)]
#[path = "readiness_tests.rs"]
mod readiness_tests;
