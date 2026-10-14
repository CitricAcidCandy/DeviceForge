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

#[test]
fn metric_missing_requires_full_diagnostics_and_only_nonzero_one() {
    use apk_plugin_sdk::MetricUnavailableReason::{PermissionDenied, Unsupported};
    use deviceforge_tool_process::Error as Tool;
    use missing::Metric::{Cpu, Memory};
    for (metric, text, reason) in [
        (Cpu, "cat: /proc/stat: Permission denied", PermissionDenied),
        (Cpu, "cat: /proc/stat: Operation not supported", Unsupported),
        (
            Memory,
            "dumpsys: meminfo: Permission denied",
            PermissionDenied,
        ),
        (Memory, "dumpsys: meminfo: not supported", Unsupported),
        (
            Memory,
            "Permission Denial: can't dump meminfo from from pid=123, uid=2000 without permission android.permission.DUMP",
            PermissionDenied,
        ),
        (
            Memory,
            "Permission Denial: can't dump ActivityManager from from pid=123, uid=2000 due to missing android.permission.DUMP permission",
            PermissionDenied,
        ),
    ] {
        assert_eq!(
            missing::diagnostic(metric, text.as_bytes(), b""),
            Some(reason)
        );
        assert_eq!(
            missing::diagnostic(metric, b"", text.as_bytes()),
            Some(reason)
        );
        assert_eq!(
            missing::nonzero(
                metric,
                &Tool::NonZeroExit {
                    code: Some(1),
                    stderr: text.as_bytes().to_vec(),
                }
            ),
            Some(reason)
        );
        for code in [None, Some(2), Some(7), Some(-1)] {
            assert_eq!(
                missing::nonzero(
                    metric,
                    &Tool::NonZeroExit {
                        code,
                        stderr: text.as_bytes().to_vec(),
                    }
                ),
                None
            );
        }
    }
    for text in [
        "",
        "Permission Denied",
        "permission denial",
        "unsupported",
        "cat: /proc/123/stat: Permission denied",
        "cat: /proc/stat: No such file or directory",
        "cat: /proc/stat: Permission denied and unknown detail",
        "device offline",
        "unauthorized",
        "Permission Denial: can't dump meminfo from from pid=x, uid=2000 without permission android.permission.DUMP",
        "Permission Denial: can't dump meminfo from from pid=123, uid=4294967296 without permission android.permission.DUMP",
        "Permission Denial: can't dump meminfo from from pid=123, uid=2000 without permission android.permission.DUMP extra",
    ] {
        for metric in [Cpu, Memory] {
            assert_eq!(missing::diagnostic(metric, text.as_bytes(), b""), None);
            assert_eq!(
                missing::nonzero(
                    metric,
                    &Tool::NonZeroExit {
                        code: Some(1),
                        stderr: text.as_bytes().to_vec(),
                    }
                ),
                None
            );
        }
    }
    assert_eq!(
        missing::diagnostic(Cpu, b"cat: /proc/stat: Permission denied\xff", b""),
        None
    );
    assert_eq!(
        missing::diagnostic(Cpu, b"cat: /proc/stat: Permission denied", b"unknown"),
        None
    );
}

#[test]
fn metric_diagnostics_mixed_with_data_or_conflicting_reasons_are_hard_failures() {
    use missing::Metric::{Cpu, Memory};
    let cpu = b"cpu 1 2 3 4\ncpu0 0\n";
    let memory = b"** MEMINFO in pid 123 [app] **\nTOTAL PSS: 42\n";
    for (metric, data, diagnostic) in [
        (Cpu, cpu.as_slice(), "cat: /proc/stat: Permission denied"),
        (
            Cpu,
            cpu.as_slice(),
            "cat: /proc/stat: Operation not supported",
        ),
        (Cpu, cpu.as_slice(), "cat: /proc/stat: unknown failure"),
        (Cpu, cpu.as_slice(), "Operation not supported: /proc/stat"),
        (Cpu, cpu.as_slice(), "Unsupported interface: /proc/stat"),
        (Cpu, cpu.as_slice(), "Interface /proc/stat is unsupported"),
        (
            Memory,
            memory.as_slice(),
            "dumpsys: meminfo: Permission denied",
        ),
        (Memory, memory.as_slice(), "dumpsys: meminfo: not supported"),
        (
            Memory,
            memory.as_slice(),
            "Function not implemented: meminfo",
        ),
        (Memory, memory.as_slice(), "meminfo=unsupported"),
        (Memory, memory.as_slice(), "Not supported: meminfo"),
        (
            Memory,
            memory.as_slice(),
            "dumpsys: meminfo: unknown failure",
        ),
    ] {
        assert!(missing::output(metric, data, diagnostic.as_bytes()).is_err());
        assert!(missing::output(metric, diagnostic.as_bytes(), data).is_err());
        let mut same_stream = data.to_vec();
        same_stream.extend_from_slice(diagnostic.as_bytes());
        assert!(missing::output(metric, &same_stream, b"").is_err());
        assert!(missing::output(metric, b"", &same_stream).is_err());
        // 硬拒绝识别扩大，不等于允许未知诊断降级缺测。
        if !diagnostic.starts_with("cat:") && !diagnostic.starts_with("dumpsys:") {
            assert_eq!(
                missing::diagnostic(metric, diagnostic.as_bytes(), b""),
                None
            );
        }
    }
    assert!(
        missing::output(
            Cpu,
            b"cat: /proc/stat: Permission denied\ncat: /proc/stat: Operation not supported",
            b""
        )
        .is_err()
    );
    let valid_package = b"** MEMINFO in pid 123 [com.unsupported.example] **\nTOTAL PSS: 42\n";
    let missing::Value::Available(valid_output) =
        missing::output(Memory, valid_package, b"").unwrap()
    else {
        panic!("包名中的unsupported不是拒绝诊断");
    };
    assert_eq!(
        super::memory(&valid_output, 123, &|| Ok(())).unwrap(),
        (42, None)
    );
    for text in [
        "** MEMINFO in pid 124 [app] **\nTOTAL PSS: 42\n",
        "** MEMINFO in pid 123 [app] **\n** MEMINFO in pid 123 [app] **\nTOTAL PSS: 42\n",
        "** MEMINFO in pid 123 [app] **\nTOTAL PSS: -1\n",
    ] {
        let missing::Value::Available(output) =
            missing::output(Memory, text.as_bytes(), b"").unwrap()
        else {
            panic!("无拒绝诊断的正文不得降级缺测");
        };
        assert!(super::memory(&output, 123, &|| Ok(())).is_err());
    }
}

#[test]
fn metric_missing_never_reclassifies_control_or_cleanup_errors() {
    use deviceforge_tool_process::{Error as Tool, OutputStream};
    let errors = [
        Tool::Cancelled,
        Tool::Timeout,
        Tool::InvalidOptions("配置错误"),
        Tool::Spawn(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
        Tool::ProcessIo(std::io::Error::from(std::io::ErrorKind::BrokenPipe)),
        Tool::OutputTooLarge {
            stream: OutputStream::Stderr,
            limit: 1,
        },
        Tool::CleanupFailed {
            cause: Box::new(Tool::NonZeroExit {
                code: Some(1),
                stderr: b"cat: /proc/stat: Permission denied".to_vec(),
            }),
        },
    ];
    for error in errors {
        assert_eq!(missing::nonzero(missing::Metric::Cpu, &error), None);
        assert_eq!(missing::nonzero(missing::Metric::Memory, &error), None);
    }
}

#[test]
fn android9_app_summary_total_keeps_pss_and_does_not_infer_rss_or_swap() {
    let output = "Applications Memory Usage (in Kilobytes):\r\n** MEMINFO in pid 3540 [com.example.game] **\r\n App Summary\r\n Pss(KB)\r\n TOTAL: 712749 TOTAL SWAP PSS: 90\r\n";
    assert_eq!(memory(output, 3540, &|| Ok(())).unwrap(), (712749, None));
    assert!(memory(output, 3541, &|| Ok(())).is_err());
    assert!(
        memory(
            &output.replace("App Summary", "Unknown Summary"),
            3540,
            &|| Ok(())
        )
        .is_err()
    );
    assert!(memory(&format!("{output}TOTAL PSS: 712748\n"), 3540, &|| Ok(())).is_err());
    assert!(memory(&output.replace("712749", "-1"), 3540, &|| Ok(())).is_err());
    assert!(
        memory(
            &output.replace("712749", "18446744073709551616"),
            3540,
            &|| Ok(())
        )
        .is_err()
    );
}

#[test]
fn android9_summary_accepts_only_the_target_pss_column_and_known_numeric_rows() {
    let output = "** MEMINFO in pid 3540 [com.example.game] **\r\n\
 App Summary\r\n\
                       Pss(KB)\r\n\
                        ------\r\n\
           Java Heap:    19408\r\n\
         Native Heap:    53052\r\n\
                Code:   107388\r\n\
               Stack:       52\r\n\
            Graphics:        0\r\n\
       Private Other:   522548\r\n\
              System:     8245\r\n\
 \r\n\
               TOTAL:   710693       TOTAL SWAP PSS:        0\r\n\
 Objects\r\n Views: 31\r\n";
    assert_eq!(memory(output, 3540, &|| Ok(())).unwrap(), (710693, None));
    let maximum = format!(
        "** MEMINFO in pid 3540 [app] **\nApp Summary\nPss(KB)\nSystem: {}\nTOTAL: {}\n",
        u64::MAX,
        u64::MAX
    );
    assert_eq!(
        memory(&maximum, 3540, &|| Ok(())).unwrap(),
        (u64::MAX, None)
    );
}

#[test]
fn android9_summary_closes_on_missing_or_other_column_and_unknown_sections() {
    let header = "** MEMINFO in pid 123 [app] **\nApp Summary\n";
    for body in [
        "TOTAL: 42\n",
        "Rss(KB)\nTOTAL: 42\n",
        "Pss(KB) Rss(KB)\nTOTAL: 42\n",
        "Pss(Kb)\nTOTAL: 42\n",
        "Pss(KB)\nObjects\nTOTAL: 42\n",
        "Pss(KB)\nJava Heap: 1\nObjects\nTOTAL: 42\n",
        "Pss(KB)\nUnknown Summary\nTOTAL: 42\n",
        "Pss(KB)\nUnknown: 1\nTOTAL: 42\n",
        "Pss(KB)\nJava Heap: 1\nRss(KB)\nTOTAL: 42\n",
        "Objects\nPss(KB)\nTOTAL: 42\n",
    ] {
        assert!(memory(&format!("{header}{body}"), 123, &|| Ok(())).is_err());
    }
}

#[test]
fn android9_summary_must_follow_the_target_identity_and_exact_title() {
    for output in [
        "App Summary\nPss(KB)\n** MEMINFO in pid 123 [app] **\nTOTAL: 42\n",
        "App Summary\n** MEMINFO in pid 123 [app] **\nPss(KB)\nTOTAL: 42\n",
        "** MEMINFO in pid 123 [app] **\nApp Summary extra\nPss(KB)\nTOTAL: 42\n",
        "** MEMINFO in pid 123 [app] **\napp summary\nPss(KB)\nTOTAL: 42\n",
    ] {
        assert!(memory(output, 123, &|| Ok(())).is_err());
    }
}

#[test]
fn android9_summary_rejects_invalid_known_numeric_rows_and_total_counts() {
    let header = "** MEMINFO in pid 123 [app] **\nApp Summary\nPss(KB)\n";
    for row in [
        "Java Heap:",
        "Native Heap: -1",
        "Code: +1",
        "Stack: 1.5",
        "Graphics: unknown",
        "Private Other: 18446744073709551616",
        "System: 1 2",
    ] {
        assert!(memory(&format!("{header}{row}\nTOTAL: 42\n"), 123, &|| Ok(())).is_err());
    }
    for count in ["", "-1", "+1", "1.5", "18446744073709551616"] {
        assert!(memory(&format!("{header}TOTAL: {count}\n"), 123, &|| Ok(())).is_err());
    }
}

#[test]
fn android9_summary_rejects_repeated_total_instead_of_overwriting_the_value() {
    let header = "** MEMINFO in pid 123 [app] **\nApp Summary\nPss(KB)\n";
    for next in [
        "TOTAL: 42\n",
        "TOTAL: 43\n",
        "\nTOTAL: 42\n",
        "\nTOTAL: 43\n",
        "App Summary\nPss(KB)\nTOTAL: 42\n",
        "App Summary\nPss(KB)\nTOTAL: 43\n",
    ] {
        let output = format!("{header}TOTAL: 42\n{next}");
        assert!(memory(&output, 123, &|| Ok(())).is_err());
    }
}

#[test]
fn android9_consumed_summary_never_reads_a_later_sections_total() {
    let header = "** MEMINFO in pid 123 [app] **\nApp Summary\nPss(KB)\nTOTAL: 42\n";
    for next in [
        "Objects\nTOTAL: 99\n",
        "Unknown Summary\nTOTAL: 99\n",
        "Rss(KB)\nTOTAL: 99\n",
        "Java Heap: 7\nTOTAL: 99\n",
    ] {
        assert_eq!(
            memory(&format!("{header}{next}"), 123, &|| Ok(())).unwrap(),
            (42, None)
        );
    }
    assert_eq!(
        memory(
            &format!("{header}TOTAL PSS: 42 TOTAL RSS: 84\n"),
            123,
            &|| Ok(())
        )
        .unwrap(),
        (42, Some(84))
    );
    assert!(memory(&format!("{header}TOTAL PSS: 43\n"), 123, &|| Ok(())).is_err());
}
