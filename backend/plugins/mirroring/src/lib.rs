//! 投屏录像及公开协议5直播；真实工具、真机与播放独立验收。
mod config;
pub mod entry;
mod live;
mod model;
use apk_plugin_sdk::{ArtifactOutput, Request, cooperative::CleanupOutcome};
use deviceforge_plugin_runtime::{Execution, InvocationContext, Output};
use deviceforge_tool_process::{Environment, ExecutionOptions, ToolCommand, capture};
pub use live::execute as execute_stream;
use serde_json::json;
use std::path::PathBuf;
use tokio::io::AsyncReadExt;
const LIMIT: u64 = 128 * 1024 * 1024;
pub async fn execute(request: Request, context: InvocationContext) -> Execution {
    let mut cleanup = CleanupOutcome::Complete;
    let mut failed_output = None;
    let result=async{
        context.check().map_err(|error|error.to_string())?;
        let config=config::read().await?;
        if request.operation=="runtime.status"{
            if request.input!=json!({}){return Err("投屏状态输入须为空对象".into());}
            let args=vec!["--version".into()];
            let mut command=ToolCommand::new(&config.scrcpy,&args);command.environment=Environment::Restricted;
            let output=capture(command,ExecutionOptions::new(context.deadline().into()),context.cancellation()).await.map_err(|error|{if matches!(error,deviceforge_tool_process::Error::CleanupFailed{..}){cleanup=CleanupOutcome::Failed;}"scrcpy工具检查失败".to_owned()})?;
            return Ok(Output::from(json!({"available":true,"version":String::from_utf8(output.stdout).map_err(|_|"scrcpy版本不是UTF-8")?,"live_stream":true,"live_configured":config.live.is_some(),"recording":true})));
        }
        if request.operation!="record"{return Err("未知投屏操作".into());}
        let input:model::Input=serde_json::from_value(request.input).map_err(|_|"投屏录制输入无效")?;input.validate()?;
        let root=PathBuf::from(request.artifacts.as_ref().and_then(|value|value.output_directory.as_ref()).ok_or("未授权视频输出")?);
        if !root.is_absolute() || !tokio::fs::symlink_metadata(&root).await.is_ok_and(|meta|meta.is_dir()&&!meta.file_type().is_symlink()){return Err("视频输出授权无效".into());}
        let path=root.join("screen.mp4");
        if tokio::fs::try_exists(&path).await.map_err(|_|"无法检查视频输出")?{return Err("视频目标已存在".into());}
        failed_output=Some(path.clone());
        let args=input.args(path.to_str().ok_or("视频输出路径不是UTF-8")?);
        let mut command=ToolCommand::new(&config.scrcpy,&args);command.environment=Environment::Restricted;command.env.insert("ADB".into(),config.adb.into());
        let stop=context.cancellation().child_token();
        let work=capture(command,ExecutionOptions::new(context.deadline().into()),stop.clone());tokio::pin!(work);
        // 录制文件由工具写入；定时检查文件量，超限取消并等待真实进程回收。
        loop{
            tokio::select!{
                result=&mut work=>{if let Err(error)=result{if matches!(error,deviceforge_tool_process::Error::CleanupFailed{..}){cleanup=CleanupOutcome::Failed;}return Err("scrcpy录制失败".into());}break;},
                _=tokio::time::sleep(std::time::Duration::from_millis(50))=>{
                    if tokio::fs::metadata(&path).await.is_ok_and(|meta|meta.len()>LIMIT){stop.cancel();let result=(&mut work).await;if matches!(result,Err(deviceforge_tool_process::Error::CleanupFailed{..})){cleanup=CleanupOutcome::Failed;}return Err("视频产物超限".into());}
                }
            }
        }
        context.check().map_err(|error|error.to_string())?;
        let meta=tokio::fs::symlink_metadata(&path).await.map_err(|_|"工具未生成视频")?;
        if !meta.is_file()||meta.file_type().is_symlink()||meta.len()>LIMIT{return Err("视频产物无效".into());}
        let mut file=tokio::fs::File::open(&path).await.map_err(|_|"无法读取视频产物")?;let mut header=[0_u8;12];file.read_exact(&mut header).await.map_err(|_|"MP4头部不完整")?;
        if !model::mp4(&header){return Err("工具输出不是MP4".into());}
        Ok(Output{value:json!({"device_id":input.device_id,"duration_ms":input.duration_ms.div_ceil(1000)*1000,"codec":"h264","filename":"screen.mp4","size":meta.len(),"live_stream":false}),artifacts:vec![ArtifactOutput{filename:"screen.mp4".into()}]})
    }.await;
    if result.is_err()
        && cleanup == CleanupOutcome::Complete
        && let Some(path) = failed_output
        && let Err(error) = tokio::fs::remove_file(path).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        cleanup = CleanupOutcome::Failed;
    }
    Execution {
        outcome: result,
        cleanup,
    }
}
