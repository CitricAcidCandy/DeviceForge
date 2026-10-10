//! 真实内核字段位置与错误计数/身份；本模块不替代工具、服务或真机验收。
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

fn stat(pid: u32, user: &str, kernel: &str, start: &str) -> String {
    let mut fields = vec!["0"; 20];
    fields[0] = "S";
    fields[11] = user;
    fields[12] = kernel;
    fields[19] = start;
    format!("{pid} (app ) nested (name)) {}", fields.join(" "))
}

#[test]
fn package_matches_the_legacy_performance_target_including_underscore() {
    for value in ["com.example", "_app._process", "a._", "com.failed.example"] {
        assert!(package(value).is_ok());
    }
    assert!(package(&format!("{}.a", "a".repeat(198))).is_ok());
    for value in [
        "com", "a..b", ".a", "1a.b", "a.-b", "a.b ", "a.b;id", "汉.a",
    ] {
        assert!(package(value).is_err());
    }
    assert!(package(&format!("{}.a", "a".repeat(199))).is_err());
}

#[test]
fn pid_requires_a_single_nonzero_unsigned_process_identifier() {
    assert_eq!(pid(" \n123\t").unwrap(), 123);
    assert_eq!(pid("4294967295").unwrap(), u32::MAX);
    for value in ["", "0", "123 124", "-1", "+1", "1.0", "4294967296", "pid=1"] {
        assert!(pid(value).is_err());
    }
}

#[test]
fn process_uses_last_name_delimiter_and_real_cpu_and_start_fields() {
    assert_eq!(
        process(&stat(123, "12", "8", "900"), 123).unwrap(),
        (20, 900)
    );
    assert!(process(&stat(124, "12", "8", "900"), 123).is_err());
    assert!(process("123 bad S 0", 123).is_err());
    assert!(process("123 (name) S 1", 123).is_err());
    assert!(process(&stat(123, "1", "x", "900"), 123).is_err());
    assert!(process(&stat(123, "1", "2", "-900"), 123).is_err());
    assert!(process(&stat(123, "18446744073709551615", "1", "900"), 123).is_err());
}

#[test]
fn system_excludes_guest_and_counts_distinct_logical_cores() {
    let output = "cpu 10 2 3 100 4 5 6 7 99999 99999\ncpu0 1 1 1 1\ncpu1 1 1 1 1\nintr 9\n";
    assert_eq!(system(output, &|| Ok(())).unwrap(), (137, 2));
    assert_eq!(
        system("cpu 1 2 3 4\ncpu9 0\n", &|| Ok(())).unwrap(),
        (10, 1)
    );
    for output in [
        "cpu 1 2 3\ncpu0 1\n",
        "cpu 1 2 3 4 5 6 7 8 9 10 11\ncpu0 1\n",
        "cpu 0 0 0 0\ncpu0 1\n",
        "cpu 1 2 x 4\ncpu0 1\n",
        "cpu 18446744073709551615 1 0 0\ncpu0 1\n",
        "cpu 1 2 3 4\ncpu0 1\ncpu0 1\n",
        "cpu 1 2 3 4\ncpu00 1\ncpu0 1\n",
        "cpu 1 2 3 4\ncpu 1 2 3 4\ncpu0 1\n",
        "cpu 1 2 3 4\n",
        "cpu0 1 2 3 4\n",
    ] {
        assert!(system(output, &|| Ok(())).is_err());
    }
}

#[test]
fn system_core_capacity_has_a_real_4096_boundary() {
    let mut output = "cpu 1 2 3 4\n".to_owned();
    for index in 0..4096 {
        output.push_str(&format!("cpu{index} 0 0 0 0\n"));
    }
    assert_eq!(system(&output, &|| Ok(())).unwrap(), (10, 4096));
    output.push_str("cpu4096 0 0 0 0\n");
    assert!(system(&output, &|| Ok(())).is_err());
}

#[test]
fn memory_requires_the_matching_header_and_consistent_optional_rss() {
    let output =
        "** MEMINFO in pid 123 [com.example] **\nTOTAL 42 0 0\nTOTAL PSS: 42 TOTAL RSS: 84\n";
    assert_eq!(memory(output, 123, &|| Ok(())).unwrap(), (42, Some(84)));
    assert_eq!(
        memory(
            "** MEMINFO in pid 123 [com.example] **\nTOTAL PSS: 0\n",
            123,
            &|| Ok(())
        )
        .unwrap(),
        (0, None)
    );
    for output in [
        "TOTAL PSS: 42\n",
        "** MEMINFO in pid 124 [app] **\nTOTAL PSS: 42\n",
        "** MEMINFO in pid 123 [app] **\n** MEMINFO in pid 123 [app] **\nTOTAL PSS: 42\n",
        "** MEMINFO in pid 123 [app] **\nTOTAL RSS: 42\n",
        "** MEMINFO in pid 123 [app] **\nTOTAL 42 0\nTOTAL PSS: 43\n",
        "** MEMINFO in pid 123 [app] **\nTOTAL PSS: 42\nTOTAL RSS: 84\nTOTAL RSS: 85\n",
        "** MEMINFO in pid 123 [app] **\nTOTAL PSS: -1\n",
        "** MEMINFO in pid 123 [app] **\nTOTAL PSS: 18446744073709551616\n",
    ] {
        assert!(memory(output, 123, &|| Ok(())).is_err());
    }
}

#[test]
fn line_parsers_observe_cancel_and_deadline_checks_during_work() {
    let calls = AtomicUsize::new(0);
    let check = || {
        if calls.fetch_add(1, Ordering::Relaxed) == 0 {
            Ok(())
        } else {
            Err(Error::Cancelled)
        }
    };
    assert!(matches!(
        system("cpu 1 2 3 4\ncpu0 0\n", &check),
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        memory(
            "** MEMINFO in pid 123 [app] **\nTOTAL PSS: 42\n",
            123,
            &|| Err(Error::Timeout)
        ),
        Err(Error::Timeout)
    ));
}

#[test]
fn merged_lossy_output_keeps_eight_failure_markers_in_either_stream() {
    assert_eq!(output(b"123\n", b" ").unwrap(), "123");
    assert_eq!(output(b"app\xff", b"").unwrap(), "app\u{fffd}");
    for marker in [
        "Permission Denied",
        "permission denial",
        "no such file",
        "error:",
        "exception",
        "not found",
        "device offline",
        "unauthorized",
    ] {
        assert!(output(marker.as_bytes(), b"").is_err());
        assert!(output(b"123", marker.as_bytes()).is_err());
    }
}
