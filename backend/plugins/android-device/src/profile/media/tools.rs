//! 媒体直接工具与资源清理独立监督；不占用性能短调用租约。
use crate::{Error,Result,session::Session};
use deviceforge_tool_process::{Environment,ExecutionOptions,ToolCommand,capture};
use std::sync::{Arc,atomic::{AtomicBool,Ordering}};
use tokio_util::sync::CancellationToken;
pub(super) struct Guard {pub unresolved:Arc<AtomicBool>,pub clean:bool}
impl Guard {pub fn new(session:&Session)->Self{Self{unresolved:session.control.unresolved.clone(),clean:false}}}
impl Drop for Guard {fn drop(&mut self){if !self.clean{self.unresolved.store(true,Ordering::Release);}}}
pub(super) async fn run(executable:&str,args:&[String],deadline:tokio::time::Instant,cancel:CancellationToken,limit:u64,unresolved:&Arc<AtomicBool>)->Result<Vec<u8>> {
    let mut command=ToolCommand::new(executable,args);command.environment=Environment::Restricted;
    let mut options=ExecutionOptions::new(deadline);options.stdout_limit=limit;options.stderr_limit=64*1024;
    match capture(command,options,cancel).await {
        Ok(output)=>Ok(output.stdout),
        Err(deviceforge_tool_process::Error::CleanupFailed{..})=>{unresolved.store(true,Ordering::Release);Err(Error::CleanupFailed)},
        Err(deviceforge_tool_process::Error::Cancelled)=>Err(Error::Cancelled),
        Err(deviceforge_tool_process::Error::Timeout)=>Err(Error::Timeout),
        Err(_)=>Err(Error::Dependency("视频工具调用失败")),
    }
}
pub(super) async fn adb(session:&Session,device:&str,tail:Vec<String>)->Result<Vec<u8>> {
    session.control.check()?;let mut args=vec!["-s".into(),device.into()];args.extend(tail);
    run(&session.control.executable,&args,session.control.context.deadline().into(),session.control.context.cancellation(),64*1024,&session.control.unresolved).await
}
pub(super) fn script_args(script:&str)->Vec<String>{vec!["shell".into(),"-T".into(),"/system/bin/sh".into(),"-c".into(),crate::profile::root::quote(script)]}
