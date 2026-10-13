//! 采集任务独占scrcpy服务、转发及远端目录；不复用别人会话。
use super::{tools, rules::{self,Anchor}};
use crate::{Error,Result,session::Session,config::profile::Profile};
use deviceforge_tool_process::{Environment,ExecutionOptions,StreamOptions,StreamingProcess,ToolCommand,spawn_stream};
use std::time::Duration;
use tokio::net::TcpStream;
pub(super) struct Device {pub directory:String,pub nonce:String,pub scid:String,pub port:Option<u16>,pub created:bool,pub forwarded:bool,pub launched:bool,pub server:Option<StreamingProcess>}
impl Device {
    pub fn new()->Self {use sha2::{Digest,Sha256};let raw=format!("{}-{}-{:?}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos(),std::thread::current().id());let nonce=format!("{:x}",Sha256::digest(raw.as_bytes()));let value=u32::from_str_radix(&nonce[..8],16).unwrap_or(1)&0x7fff_ffff;Self{directory:format!("/data/local/tmp/df_profile_video_{nonce}"),nonce,scid:format!("{:08x}",value.max(1)),port:None,created:false,forwarded:false,launched:false,server:None}}
    pub async fn prepare(&mut self,session:&Session,device:&str,profile:&Profile)->Result<()> {
        let jar=profile.scrcpy_server.as_ref().ok_or(Error::Dependency("未部署scrcpy服务"))?;
        let clock=profile.clock_helper.as_ref().ok_or(Error::Dependency("未部署设备时钟助手"))?;
        for file in [jar,clock] {session.work({let path=file.clone();move|check|{check()?;let meta=crate::session::files::regular(&path,false)?;if meta.len()==0||meta.len()>64*1024*1024{return Err(Error::TooLarge);}Ok(())}}).await?;}
        self.created=true;let out=tools::adb(session,device,tools::script_args(&format!("umask 077; mkdir {}",self.directory))).await?;if !out.is_empty(){return Err(Error::Dependency("视频私有目录创建回执无效"));}
        for (file,name) in [(jar,"server.jar"),(clock,"clock.jar")] {tools::adb(session,device,vec!["push".into(),file.to_str().ok_or(Error::Invalid("视频部署路径须为UTF-8"))?.into(),format!("{}/{name}",self.directory)]).await?;}
        self.forwarded=true;let raw=tools::adb(session,device,vec!["forward".into(),"--no-rebind".into(),"tcp:0".into(),format!("localabstract:scrcpy_{}",self.scid)]).await?;
        self.port=Some(std::str::from_utf8(&raw).ok().and_then(|s|s.trim().parse::<u16>().ok()).filter(|p|*p>0).ok_or(Error::Dependency("视频独占端口回执无效"))?);
        let script=format!("cat /proc/$$/stat > {dir}/owner.stat && CLASSPATH={dir}/server.jar exec app_process / --nice-name=df_profile_video_{nonce} com.genymobile.scrcpy.Server 3.3.1 scid={scid} tunnel_forward=true video=true audio=false control=false video_codec=h264 max_size=640 max_fps=30 video_bit_rate=2000000 video_codec_options=max-bframes=0 send_device_meta=false send_dummy_byte=false send_codec_meta=true send_frame_meta=true cleanup=false power_on=false",dir=self.directory,nonce=self.nonce,scid=self.scid);
        let mut args=vec!["-s".into(),device.into()];args.extend(tools::script_args(&script));let mut cmd=ToolCommand::new(&session.control.executable,&args);cmd.environment=Environment::Restricted;
        self.launched=true;self.server=Some(spawn_stream(cmd,StreamOptions::new(ExecutionOptions::new(session.control.context.deadline().into())),session.control.context.cancellation()).await.map_err(|_|Error::Dependency("scrcpy视频服务启动失败"))?);Ok(())
    }
    pub async fn anchor(&self,session:&Session,device:&str)->Result<Anchor> {
        let text=tools::adb(session,device,tools::script_args(&format!("CLASSPATH={}/clock.jar app_process / com.deviceforge.profile.ClockAnchor",self.directory))).await?;
        rules::anchor(std::str::from_utf8(&text).map_err(|_|Error::Dependency("视频时钟回执不是UTF-8"))?)
    }
    pub async fn connect(&self,session:&Session)->Result<TcpStream> {
        let port=self.port.ok_or(Error::Dependency("视频转发尚未创建"))?;let until=tokio::time::Instant::from_std(session.control.context.deadline()).min(tokio::time::Instant::now()+Duration::from_secs(5));
        loop {session.control.context.check()?;match TcpStream::connect((std::net::Ipv4Addr::LOCALHOST,port)).await {Ok(s)=>return Ok(s),Err(_)if tokio::time::Instant::now()<until=>tokio::time::sleep(Duration::from_millis(25)).await,Err(_)=>return Err(Error::Dependency("scrcpy视频连接失败"))}}
    }
}
