use serde::{Deserialize, Serialize};
use serde_json::Value;
pub mod cooperative;
pub mod devices;
pub mod packages;
pub const PROTOCOL_VERSION: u32 = 1;
pub const ARTIFACT_PROTOCOL_VERSION: u32 = 2;
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactAccess {
    #[serde(default)]
    pub input_fields: Vec<String>,
    #[serde(default)]
    pub outputs: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactInput {
    pub field: String,
    pub artifact_id: String,
    pub filename: String,
    pub size: u64,
    pub sha256: String,
    pub path: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactContext {
    pub inputs: Vec<ArtifactInput>,
    pub output_directory: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactOutput {
    pub filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contribution {
    pub name: String,
    pub title: String,
    pub input_schema: Value,
}
/// 性能采样操作仍使用普通请求 / 响应协议，宿主按此声明选择采样端口。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PerformanceAccess {
    pub sample_operation: String,
    #[serde(default)]
    pub fps: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PerformanceTarget {
    pub device_id: String,
    pub package: String,
}
/// FPS 必须携带观测窗口与实际帧数，不能只提供缺乏口径的百分比。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrameWindow {
    pub frames: u64,
    pub duration_ms: u32,
    pub source: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PerformanceSample {
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
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub version: String,
    pub protocol_version: u32,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub operations: Vec<Contribution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<ArtifactAccess>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub performance: Option<PerformanceAccess>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub devices: Option<devices::DeviceProviderAccess>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub protocol_version: u32,
    pub request_id: String,
    pub operation: String,
    pub input: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<ArtifactContext>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub protocol_version: u32,
    pub request_id: String,
    // 区分缺失字段和显式 null，允许插件返回合法的 JSON 空值。
    #[serde(
        default,
        deserialize_with = "present_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outputs: Vec<ArtifactOutput>,
}
fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn null_result_is_present_and_error_is_omitted() {
        let response = Response {
            protocol_version: 1,
            request_id: "a".into(),
            result: Some(Value::Null),
            error: None,
            outputs: Vec::new(),
        };
        let value = serde_json::to_value(response).unwrap();
        assert!(value.get("error").is_none());
        let parsed: Response = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.result, Some(Value::Null));
    }
    #[test]
    fn legacy_json_omits_artifact_fields_and_v2_roundtrips() {
        let legacy: Request = serde_json::from_value(serde_json::json!({"protocol_version":1,"request_id":"a","operation":"echo","input":null})).unwrap();
        assert!(legacy.artifacts.is_none());
        assert!(
            serde_json::to_value(legacy)
                .unwrap()
                .get("artifacts")
                .is_none()
        );
        let response: Response = serde_json::from_value(serde_json::json!({"protocol_version":2,"request_id":"b","result":null,"outputs":[{"filename":"result.zip"}]})).unwrap();
        assert_eq!(response.result, Some(Value::Null));
        assert_eq!(response.outputs[0].filename, "result.zip");
        assert!(
            serde_json::from_value::<ArtifactAccess>(serde_json::json!({"server_path":"secret"}))
                .is_err()
        );
    }
}

#[cfg(test)]
mod performance_tests {
    use super::*;
    #[test]
    fn legacy_manifest_and_public_sample_are_compatible() {
        let legacy: Manifest = serde_json::from_value(serde_json::json!({"id":"legacy","version":"0.1.0","protocol_version":1,"executable":"example","operations":[]})).unwrap();
        assert!(legacy.performance.is_none());
        assert!(
            serde_json::to_value(legacy)
                .unwrap()
                .get("performance")
                .is_none()
        );
        let sample = serde_json::json!({"captured_at":1,"pid":123,"process_start_ticks":900,"process_ticks":10,"system_ticks":100,"logical_cpus":2,"pss_kib":2048,"rss_kib":null});
        let parsed: PerformanceSample = serde_json::from_value(sample.clone()).unwrap();
        assert!(parsed.frame_window.is_none());
        assert_eq!(serde_json::to_value(parsed).unwrap(), sample);
        let mut invalid = sample;
        invalid["extra"] = serde_json::json!(true);
        assert!(serde_json::from_value::<PerformanceSample>(invalid).is_err());
        assert!(
            serde_json::from_value::<PerformanceAccess>(
                serde_json::json!({"sample_operation":"sample","shell":"reboot"})
            )
            .is_err()
        );
    }
}
