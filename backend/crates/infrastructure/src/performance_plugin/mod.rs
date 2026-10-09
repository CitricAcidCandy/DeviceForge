use crate::plugins::ProcessPlugin;
use apk_domain::{
    Error, Executor, PluginArtifactResult, Result, now,
    performance::{
        FrameWindow, PerformanceProbe, PerformanceTarget, ProbeCapabilities, RawPerformance,
    },
};
use apk_plugin_sdk::PerformanceSample;
use async_trait::async_trait;
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

pub struct PluginPerformance {
    plugin: Arc<ProcessPlugin>,
    operation: String,
    validator: jsonschema::Validator,
    capabilities: ProbeCapabilities,
}
impl PluginPerformance {
    pub fn new(plugin: Arc<ProcessPlugin>) -> Result<Self> {
        let manifest = plugin.manifest();
        let access = manifest
            .performance
            .as_ref()
            .ok_or_else(|| Error::Invalid("插件没有声明性能采样能力".into()))?;
        let contribution = manifest
            .operations
            .iter()
            .find(|operation| operation.name == access.sample_operation)
            .ok_or_else(|| Error::Invalid("插件采样操作缺失".into()))?;
        apk_domain::validate_local_schema(&contribution.input_schema)?;
        let validator = jsonschema::validator_for(&contribution.input_schema)
            .map_err(|_| Error::Invalid("插件性能输入模式无效".into()))?;
        let operation = format!("plugin.{}.{}", manifest.id, access.sample_operation);
        let capabilities = ProbeCapabilities {
            source: format!("plugin.{}", manifest.id),
            fps: access.fps,
        };
        Ok(Self {
            plugin,
            operation,
            validator,
            capabilities,
        })
    }
}
#[async_trait]
impl PerformanceProbe for PluginPerformance {
    fn capabilities(&self) -> ProbeCapabilities {
        self.capabilities.clone()
    }
    async fn sample(
        &self,
        target: &PerformanceTarget,
        cancel: CancellationToken,
    ) -> Result<RawPerformance> {
        target.validate()?;
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let request = serde_json::to_value(apk_plugin_sdk::PerformanceTarget {
            device_id: target.device_id.clone(),
            package: target.package.clone(),
        })
        .map_err(|_| Error::Invalid("性能目标序列化失败".into()))?;
        if !self.validator.is_valid(&request) {
            return Err(Error::Invalid("目标不符合插件性能输入模式".into()));
        }
        let value = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::Cancelled),
            value = tokio::time::timeout(Duration::from_secs(10),self.plugin.execute(&self.operation,request,cancel.clone())) => value.map_err(|_| Error::Timeout)??,
        };
        let result: PluginArtifactResult = serde_json::from_value(value)
            .map_err(|_| Error::Dependency("插件性能响应缺少协议 2 结果包装".into()))?;
        if !result.artifacts.is_empty() {
            return Err(Error::Dependency("性能采样不能生成产物".into()));
        }
        let sample: PerformanceSample = serde_json::from_value(result.result)
            .map_err(|_| Error::Dependency("插件性能样本类型无效".into()))?;
        if sample.frame_window.is_some() && !self.capabilities.fps {
            return Err(Error::Dependency("插件未声明 FPS 能力却返回帧数据".into()));
        }
        let time = now();
        if sample.captured_at < time.saturating_sub(60000)
            || sample.captured_at > time.saturating_add(5000)
        {
            return Err(Error::Dependency("插件性能样本时间不在当前观测窗口".into()));
        }
        let raw = RawPerformance {
            captured_at: sample.captured_at,
            pid: sample.pid,
            process_start_ticks: sample.process_start_ticks,
            process_ticks: sample.process_ticks,
            system_ticks: sample.system_ticks,
            logical_cpus: sample.logical_cpus,
            pss_kib: sample.pss_kib,
            rss_kib: sample.rss_kib,
            frame_window: sample.frame_window.map(|window| FrameWindow {
                frames: window.frames,
                duration_ms: window.duration_ms,
                source: window.source,
            }),
        };
        raw.validate()?;
        Ok(raw)
    }
}
