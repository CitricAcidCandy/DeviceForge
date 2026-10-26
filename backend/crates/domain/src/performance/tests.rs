use super::*;

fn request(interval_ms: u32, duration_secs: u32) -> PerformanceStart {
    PerformanceStart {
        target: PerformanceTarget {
            device_id: "device".into(),
            package: "com.example.app".into(),
        },
        interval_ms,
        duration_secs,
    }
}

#[test]
fn start_interval_accepts_50_to_60000_milliseconds() {
    for (interval_ms, accepted) in [
        (50, true),
        (49, false),
        (0, false),
        (60000, true),
        (60001, false),
    ] {
        let result = request(interval_ms, 1).validate();
        assert_eq!(result.is_ok(), accepted, "采样间隔：{interval_ms}");
        if !accepted {
            assert!(matches!(result, Err(Error::Invalid(message)) if message.contains("50–60000")));
        }
    }
}

#[test]
fn start_duration_bounds_are_unchanged_at_50_milliseconds() {
    for (duration_secs, accepted) in [(0, false), (1, true), (3600, true), (3601, false)] {
        assert_eq!(
            request(50, duration_secs).validate().is_ok(),
            accepted,
            "会话时长：{duration_secs}"
        );
    }
}

#[test]
fn start_schema_exposes_50_millisecond_minimum_and_original_upper_bounds() {
    let schema = serde_json::to_value(schemars::schema_for!(PerformanceStart)).unwrap();
    let properties = &schema["properties"];
    assert_eq!(properties["interval_ms"]["minimum"], 50);
    assert_eq!(properties["interval_ms"]["maximum"], 60000);
    assert_eq!(properties["duration_secs"]["minimum"], 1);
    assert_eq!(properties["duration_secs"]["maximum"], 3600);
}
