//! 后台采样复用设备准入、提供者屏障与普通执行内核，不创建嵌套 Job。
use super::*;
use apk_domain::{ExecutorResultFormat, PluginArtifactResult};

impl SourceBinding {
    pub async fn sample(
        &self,
        access: &SourceAccess,
        cancel: CancellationToken,
        deadline: Instant,
    ) -> Result<RawPerformance> {
        crate::operation_budget::check(Some(deadline), Some(&cancel))?;
        let application = access.application()?;
        let _tracked = self.claim(access, &cancel, Some(deadline))?;
        let selection = application
            .registry
            .device_admission(&self.registered, &self.input)?
            .map(|(provider, device, capability)| {
                application.device_locks.selection(
                    &provider,
                    device.as_deref(),
                    &capability.scope,
                    &capability.access,
                )
            })
            .transpose()?;
        let _guard = if let Some(selection) = selection {
            Some(tokio::select! {
                biased;
                _ = crate::devices::locks::deadline(Some(deadline)) => return Err(Error::Timeout),
                _ = self.owner.cancel.cancelled() => { cancel.cancel(); return Err(Error::Cancelled); },
                result = selection.acquire_until(&cancel, deadline) => result?,
            })
        } else {
            None
        };
        // 等待期间目录、来源或风险可能变化；锁取得后重新准入。
        self.check_current(access)?;
        crate::operation_budget::check(Some(deadline), Some(&cancel))?;
        let execution = async {
            let value = crate::execution::execute(
                self.registered.executor.as_ref(),
                &self.registered.operation.id,
                self.input.clone(),
                cancel.clone(),
                Some(self.owner.as_ref()),
                Some(deadline),
            )
            .await?;
            let raw = decode(
                value,
                self.registered.executor.result_format(),
                self.capabilities.fps,
            )?;
            crate::operation_budget::check(Some(deadline), Some(&cancel))?;
            Ok(raw)
        };
        let settled = crate::execution::settle(
            execution,
            &cancel,
            Some(self.owner.as_ref()),
            Some(deadline),
        );
        tokio::pin!(settled);
        // owner 撤销使用同一取消树与清理窗口；物理屏障在清理确认或风险登记后释放。
        tokio::select! {
            biased;
            _ = self.owner.cancel.cancelled() => { cancel.cancel(); settled.await },
            result = &mut settled => result,
        }
    }
}

fn decode(value: Value, format: ExecutorResultFormat, fps: bool) -> Result<RawPerformance> {
    let sample = match format {
        ExecutorResultFormat::Json => value,
        ExecutorResultFormat::PublishedArtifacts => {
            let envelope: PluginArtifactResult = serde_json::from_value(value)
                .map_err(|_| Error::Dependency("插件性能响应缺少结果包装".into()))?;
            if !envelope.artifacts.is_empty() {
                return Err(Error::Dependency("性能采样不能生成产物".into()));
            }
            envelope.result
        }
    };
    let raw: RawPerformance = serde_json::from_value(sample)
        .map_err(|_| Error::Dependency("插件性能样本类型无效".into()))?;
    raw.validate()?;
    if raw.frame_window.is_some() && !fps {
        return Err(Error::Dependency("插件未声明 FPS 能力却返回帧数据".into()));
    }
    let time = apk_domain::now();
    if raw.captured_at < time.saturating_sub(60000) || raw.captured_at > time.saturating_add(5000) {
        return Err(Error::Dependency("插件性能样本时间不在当前观测窗口".into()));
    }
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn raw() -> Value {
        json!({"captured_at":apk_domain::now(),"pid":1,"process_start_ticks":1,
            "process_ticks":1,"system_ticks":2,"logical_cpus":1,"pss_kib":3,"rss_kib":null})
    }
    #[test]
    fn decoding_uses_declared_format_and_never_guesses_a_wrapper() {
        let value = json!({"result":raw(),"artifacts":[]});
        assert!(decode(value.clone(), ExecutorResultFormat::Json, false).is_err());
        assert!(decode(value, ExecutorResultFormat::PublishedArtifacts, false).is_ok());
        assert!(decode(raw(), ExecutorResultFormat::Json, false).is_ok());
    }
    #[test]
    fn invalid_counts_wall_clock_and_undeclared_frames_are_rejected() {
        let mut value = raw();
        value["logical_cpus"] = json!(0);
        assert!(decode(value, ExecutorResultFormat::Json, false).is_err());
        let mut value = raw();
        value["captured_at"] = json!(apk_domain::now().saturating_add(60000));
        assert!(decode(value, ExecutorResultFormat::Json, false).is_err());
        let mut value = raw();
        value["frame_window"] = json!({"frames":30,"duration_ms":1000,"source":"fixture"});
        assert!(decode(value.clone(), ExecutorResultFormat::Json, false).is_err());
        assert!(decode(value, ExecutorResultFormat::Json, true).is_ok());
    }
}
