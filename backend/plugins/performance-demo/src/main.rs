use apk_plugin_sdk::{
    ARTIFACT_PROTOCOL_VERSION, FrameWindow, PerformanceSample, PerformanceTarget, Request, Response,
};
use std::{
    io::{Read, Write},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn run(request: &Request) -> Result<serde_json::Value, String> {
    if request.protocol_version != ARTIFACT_PROTOCOL_VERSION || request.operation != "sample" {
        return Err("示例只接受协议 2 的 sample 操作".into());
    }
    if std::env::var_os("APK_API_TOKEN").is_some() {
        return Err("插件不应继承服务器令牌".into());
    }
    let target: PerformanceTarget =
        serde_json::from_value(request.input.clone()).map_err(|_| "性能目标类型无效".to_owned())?;
    if target.device_id.is_empty() || target.package.is_empty() {
        return Err("性能目标不能为空".into());
    }
    // 此示例只演示协议；数值明确为合成数据，不访问真实设备。
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "宿主时钟无效".to_owned())?
        .as_millis() as u64;
    let mode = std::env::args().nth(1).unwrap_or_default();
    if mode == "--slow" {
        std::thread::sleep(Duration::from_secs(30));
    }
    if mode == "--error" {
        return Err("模拟性能采样失败".into());
    }
    let sample = PerformanceSample {
        captured_at: time,
        pid: 123,
        process_start_ticks: 900,
        process_ticks: time / 10,
        system_ticks: time,
        logical_cpus: 2,
        pss_kib: 2048,
        rss_kib: Some(4096),
        frame_window: Some(FrameWindow {
            frames: 60,
            duration_ms: 1000,
            source: "synthetic_demo".into(),
        }),
    };
    let mut value = serde_json::to_value(sample).map_err(|_| "示例样本序列化失败".to_owned())?;
    match mode.as_str() {
        "--bad-window" => value["frame_window"]["duration_ms"] = serde_json::json!(0),
        "--bad-source" => value["frame_window"]["source"] = serde_json::json!("server/path"),
        "--bad-frames" => value["frame_window"]["frames"] = serde_json::json!(1001),
        "--bad-pid" => value["pid"] = serde_json::json!(0),
        "--stale" => value["captured_at"] = serde_json::json!(0),
        "--future" => value["captured_at"] = serde_json::json!(u64::MAX),
        "--unknown" => value["server_path"] = serde_json::json!("rejected"),
        "--no-fps" => {
            value.as_object_mut().unwrap().remove("frame_window");
        }
        _ => {}
    }
    Ok(value)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(512 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 512 * 1024 {
        return Err("请求超过示例上限".into());
    }
    let request: Request = serde_json::from_slice(&bytes)?;
    let (result, error) = match run(&request) {
        Ok(value) => (Some(value), None),
        Err(error) => (None, Some(error)),
    };
    let response = Response {
        protocol_version: request.protocol_version,
        request_id: request.request_id,
        result,
        error,
        outputs: Vec::new(),
    };
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &response)?;
    stdout.write_all(b"\n")?;
    Ok(())
}
