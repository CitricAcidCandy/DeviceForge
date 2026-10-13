use crate::{Error, Result, identifier};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
mod observation;
mod source;
pub use observation::{
    BatteryElectricalObservation, BatteryStatus, BatterySupplyState, CurrentPolarity,
    DeviceObservation, DeviceTemperature, ObservationAccess, ObservationScope, TemperatureKind,
};
pub use source::{PerformanceDeviceCapability, PerformanceSourceDefinition, PerformanceSourceRef};

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PerformanceTarget {
    #[schemars(
        length(min = 1, max = 200),
        regex(pattern = r"^[A-Za-z0-9._:\[\]][A-Za-z0-9._:\[\]-]*$")
    )]
    pub device_id: String,
    #[schemars(
        length(min = 3, max = 200),
        regex(pattern = r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$")
    )]
    pub package: String,
}
impl PerformanceTarget {
    pub fn validate(&self) -> Result<()> {
        identifier(&self.device_id)?;
        let parts: Vec<_> = self.package.split('.').collect();
        if self.package.len() > 200
            || parts.len() < 2
            || parts.iter().any(|part| {
                part.is_empty()
                    || !part.as_bytes()[0].is_ascii_alphabetic() && part.as_bytes()[0] != b'_'
                    || !part
                        .bytes()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == b'_')
            })
        {
            return Err(Error::Invalid("性能目标必须为合法 Android 包名".into()));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PerformanceStart {
    pub target: PerformanceTarget,
    #[schemars(range(min = 1000, max = 60000))]
    pub interval_ms: u32,
    #[schemars(range(min = 1, max = 3600))]
    pub duration_secs: u32,
}
impl PerformanceStart {
    pub fn validate(&self) -> Result<()> {
        self.target.validate()?;
        if !(1000..=60000).contains(&self.interval_ms) || !(1..=3600).contains(&self.duration_secs)
        {
            return Err(Error::Invalid(
                "性能间隔应为 1000–60000 毫秒，时长应为 1–3600 秒".into(),
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PerformanceState {
    Running,
    Paused,
    Stopped,
    Completed,
    Failed,
    Interrupted,
}
impl PerformanceState {
    pub fn terminal(self) -> bool {
        !matches!(self, Self::Running | Self::Paused)
    }
    pub fn permits(self, next: Self) -> bool {
        self == next
            || !self.terminal()
                && matches!(
                    next,
                    Self::Running
                        | Self::Paused
                        | Self::Stopped
                        | Self::Completed
                        | Self::Failed
                        | Self::Interrupted
                )
    }
    pub fn key(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Stopped => "stopped",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PerformanceSession {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<PerformanceSourceRef>,
    pub request: PerformanceStart,
    pub state: PerformanceState,
    pub revision: u64,
    pub samples: u64,
    pub started_at: u64,
    pub updated_at: u64,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FrameWindow {
    pub frames: u64,
    pub duration_ms: u32,
    pub source: String,
}
impl FrameWindow {
    pub fn validate(&self) -> Result<()> {
        if !(1..=60000).contains(&self.duration_ms)
            || self.frames > u64::from(self.duration_ms)
            || self.source.is_empty()
            || self.source.len() > 80
            || !self
                .source
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || b"._-".contains(&ch))
        {
            return Err(Error::Dependency("FPS 观测窗口、帧数或来源无效".into()));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct ProbeCapabilities {
    pub source: String,
    pub fps: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub device_observation: bool,
}
/// 累计 CPU 计数只在同进程、同启动时间及同核数的相邻样本间比较。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawPerformance {
    pub captured_at: u64,
    pub pid: u32,
    pub process_start_ticks: u64,
    pub process_ticks: u64,
    pub system_ticks: u64,
    pub logical_cpus: u32,
    pub pss_kib: u64,
    pub rss_kib: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_window: Option<FrameWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_observation: Option<DeviceObservation>,
}
impl RawPerformance {
    pub fn validate(&self) -> Result<()> {
        if self.pid == 0
            || self.logical_cpus == 0
            || self.logical_cpus > 4096
            || self.system_ticks == 0
        {
            return Err(Error::Dependency("性能采样计数无效".into()));
        }
        if let Some(window) = &self.frame_window {
            window.validate()?;
        }
        if let Some(observation) = &self.device_observation {
            observation
                .validate(self.captured_at)
                .map_err(|message| Error::Dependency(message.into()))?;
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PerformanceReading {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    pub sequence: u64,
    pub captured_at: u64,
    pub pid: u32,
    pub logical_cpus: u32,
    pub cpu_share_percent: Option<f64>,
    pub cpu_core_percent: Option<f64>,
    pub pss_kib: u64,
    pub rss_kib: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_window: Option<FrameWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_observation: Option<DeviceObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub battery_net_power_mw: Option<f64>,
}
impl PerformanceReading {
    pub fn from_raw(
        sequence: u64,
        current: &RawPerformance,
        previous: Option<&RawPerformance>,
    ) -> Self {
        let share = previous
            .filter(|old| {
                old.pid == current.pid
                    && old.process_start_ticks == current.process_start_ticks
                    && old.logical_cpus == current.logical_cpus
            })
            .and_then(|old| {
                let process = current.process_ticks.checked_sub(old.process_ticks)?;
                let system = current.system_ticks.checked_sub(old.system_ticks)?;
                if system == 0 || process > system {
                    return None;
                }
                Some(process as f64 / system as f64 * 100.0)
            });
        Self {
            fps: current
                .frame_window
                .as_ref()
                .map(|window| window.frames as f64 * 1000.0 / f64::from(window.duration_ms)),
            sequence,
            captured_at: current.captured_at,
            pid: current.pid,
            logical_cpus: current.logical_cpus,
            cpu_share_percent: share,
            cpu_core_percent: share.map(|share| share * f64::from(current.logical_cpus)),
            pss_kib: current.pss_kib,
            rss_kib: current.rss_kib,
            frame_window: current.frame_window.clone(),
            device_observation: current.device_observation.clone(),
            battery_net_power_mw: current
                .device_observation
                .as_ref()
                .and_then(|observation| observation.battery.as_ref())
                .and_then(BatteryElectricalObservation::net_power_mw),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PerformanceId {
    #[schemars(length(min = 36, max = 36))]
    pub session_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PerformanceSamples {
    #[schemars(length(min = 36, max = 36))]
    pub session_id: String,
    pub after: u64,
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PerformanceList {
    #[schemars(length(min = 36, max = 36))]
    pub after_id: Option<String>,
    #[schemars(range(min = 1, max = 100))]
    pub limit: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PerformancePage {
    pub session: PerformanceSession,
    pub readings: Vec<PerformanceReading>,
    pub next_after: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PerformanceSessions {
    pub sessions: Vec<PerformanceSession>,
    pub next_after_id: Option<String>,
}
#[async_trait]
pub trait PerformanceProbe: Send + Sync {
    fn capabilities(&self) -> ProbeCapabilities {
        ProbeCapabilities {
            source: "custom".into(),
            fps: false,
            device_observation: false,
        }
    }
    async fn sample(
        &self,
        target: &PerformanceTarget,
        cancel: CancellationToken,
    ) -> Result<RawPerformance>;
}
pub trait PerformanceStore: Send + Sync {
    fn create(&self, session: PerformanceSession) -> Result<()>;
    fn get(&self, id: &str) -> Result<PerformanceSession>;
    fn transition(
        &self,
        id: &str,
        revision: u64,
        state: PerformanceState,
        error: Option<String>,
    ) -> Result<PerformanceSession>;
    fn append(&self, id: &str, revision: u64, raw: RawPerformance) -> Result<bool>;
    fn samples(&self, id: &str, after: u64, limit: u32) -> Result<PerformancePage>;
    fn list(&self, after_id: Option<&str>, limit: u32) -> Result<PerformanceSessions>;
    fn recover(&self) -> Result<u64>;
}
