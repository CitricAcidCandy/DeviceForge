//! 有界刷新任务，取消守卫跨提交窗口生效，缓存发布复核当前 owner。
use super::DeviceService;
use apk_domain::{Error, JobStatus, Result, devices::*};
use serde::Deserialize;
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Observed {
    id: String,
    state: DeviceState,
    model: Option<String>,
    capabilities: Vec<CapabilityAvailability>,
}
impl DeviceService {
    pub async fn refresh(self: &Arc<Self>, request: ProviderInput) -> Result<DeviceDirectory> {
        apk_domain::plugins::plugin_id(&request.id)?;
        if request.generation.is_empty() || request.generation.len() > 100 {
            return Err(Error::Invalid("提供者 generation 无效".into()));
        }
        let permit = self
            .refreshes
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Conflict("设备刷新已达到两项在途上限".into()))?;
        let serial = self.app.device_locks.refresh(&request.id)?;
        let cancel = CancellationToken::new();
        let _cancel = CancelOnDrop(cancel.clone());
        let service = self.clone();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let task = {
            let active = self
                .app
                .active
                .lock()
                .map_err(|_| Error::Storage("刷新准入状态异常".into()))?;
            if !active.accepting {
                return Err(Error::Conflict("任务服务正在停止".into()));
            }
            self.app.tracker.spawn(deviceforge_observability::LogContext::propagate(async move {
            let _permit=permit;
            let _serial=tokio::select!{biased;_ = cancel.cancelled()=>return Err(Error::Cancelled),guard=tokio::time::timeout_at(deadline,serial.lock_owned())=>guard.map_err(|_|Error::Timeout)?};
            let (provider,registered)=service.app.registry.provider_operation(&request.id,&request.generation,None)?;
            service.app.registry.clear_directory(&provider)?;
            if cancel.is_cancelled(){return Err(Error::Cancelled);}
            let app=service.app.clone();
            let submission_cancel=cancel.clone();
            let submission=service.app.blocking(move||app.submit_registered(&registered.operation.id.clone(),serde_json::json!({}),registered,Some(submission_cancel)));
            tokio::pin!(submission);
            let (submitted,mut interrupted)=tokio::select!{biased;
                _=cancel.cancelled()=>(None,Some(Error::Cancelled)),
                result=tokio::time::timeout_at(deadline,&mut submission)=>match result {Ok(result)=>(Some(result),None),Err(_)=>(None,Some(Error::Timeout))},
            };
            let job=match submitted {
                Some(result)=>result?,
                None=>{
                    cancel.cancel();
                    // 阻塞提交可能已创建任务；不能丢弃等待而提前释放在途名额。
                    let pending=(&mut submission).await;
                    match pending {Ok(job)=>job,Err(_)=>return Err(interrupted.take().unwrap())}
                }
            };
            let wait=async {
                loop {
                    let job=service.app.get_async(job.id.clone()).await?;
                    let active=service.app.active.lock().map_err(|_|Error::Storage("发现任务状态异常".into()))?.tokens.contains_key(&job.id);
                    if job.status.is_terminal() && !active {return Ok::<_,Error>(job);}
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            };
            tokio::pin!(wait);
            let result=if let Some(error)=interrupted {Err(error)}else{tokio::select!{biased;
                _=cancel.cancelled()=>Err(Error::Cancelled),
                result=tokio::time::timeout_at(deadline,&mut wait)=>result.unwrap_or(Err(Error::Timeout)),
            }};
            if result.is_err() {
                cancel.cancel();
                // 不提前释放刷新许可；继续等原任务取消与进程清理收敛。
                let _=(&mut wait).await;
            }
            let job=result?;
            if cancel.is_cancelled() || job.status==JobStatus::Cancelled {return Err(Error::Cancelled);}
            if job.status!=JobStatus::Succeeded {return Err(Error::Dependency("设备发现任务失败".into()));}
            let value=job.result.ok_or_else(||Error::Dependency("设备发现缺少结果".into()))?;
            let value=discovery_value(value)?;
            let observed:Vec<Observed>=serde_json::from_value(value).map_err(|_|Error::Dependency("设备发现消息无效".into()))?;
            let devices=observed.into_iter().map(|device|ProvidedDevice {reference:DeviceRef{provider_id:provider.id.clone(),generation:provider.generation.clone(),local_id:device.id},state:device.state,model:device.model,capabilities:device.capabilities}).collect::<Vec<_>>();
            apk_domain::devices::rules::devices(&provider.definition,&devices).map_err(|_|Error::Dependency("设备发现身份、能力或数量无效".into()))?;
            service.app.registry.publish_directory(DeviceDirectory{provider,observed_at:apk_domain::now(),discovery_job_id:job.id,devices},&cancel)
        }))
        };
        task.await
            .map_err(|_| Error::Dependency("设备刷新工作异常".into()))?
    }
}

fn discovery_value(value: serde_json::Value) -> Result<serde_json::Value> {
    if value.is_array() {
        return Ok(value);
    }
    // 仅接受完整的宿主产物包装，不把任意业务 result 字段当作包装。
    let fields = value
        .as_object()
        .ok_or_else(|| Error::Dependency("发现结果必须为数组或宿主包装".into()))?;
    if fields.len() != 2 || !fields.contains_key("result") || !fields.contains_key("artifacts") {
        return Err(Error::Dependency("设备发现包装结构无效".into()));
    }
    let wrapped: apk_domain::PluginArtifactResult = serde_json::from_value(value)
        .map_err(|_| Error::Dependency("设备发现产物包装无效".into()))?;
    if !wrapped.result.is_array() {
        return Err(Error::Dependency("设备发现包装必须包含数组".into()));
    }
    Ok(wrapped.result)
}
