//! 基础五命令与展示、环境接口真实进程；不复用生产解析器，不代表真机。
use crate::support::{
    self, CANCELLED, Fixture, PACKAGE, SERIAL, TOTAL_TIMEOUT, failure, performance, success,
};
use serde_json::{Value, json};
use std::{
    fs, thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn now() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

#[test]
fn sample_has_exact_base_and_optional_argv_raw_counters_zero_artifacts_and_restricted_environment()
{
    let mut fixture = Fixture::new("performance-normal");
    // 不存在的scratch_root与省略Java/JAR，证明纯采样不借安装资源或私有文件。
    let scratch = fixture.root.join("must-not-create-scratch");
    fixture.config["scratch_root"] = json!(scratch);
    fixture.save_config();
    performance::plan(&fixture, &performance::outputs());
    let before = now();
    let reply = performance::complete(&fixture, performance::request(&fixture), 9);
    let result = success(&reply);
    let captured_at = result["captured_at"].as_u64().unwrap();
    assert!((before..=now()).contains(&captured_at));
    let mut expected = json!({"pid":123,"process_start_ticks":900,"process_ticks":30,
        "system_ticks":137,"logical_cpus":2,"pss_kib":42,"rss_kib":84});
    expected["captured_at"] = json!(captured_at);
    assert_eq!(result, &expected);
    let commands: [&[&str]; 9] = [
        &["-s", SERIAL, "shell", "-T", "pidof", "-s", PACKAGE],
        &["-s", SERIAL, "shell", "-T", "cat", "/proc/123/stat"],
        &[
            "-s", SERIAL, "shell", "-T", "dumpsys", "meminfo", "-s", "123",
        ],
        &["-s", SERIAL, "shell", "-T", "cat", "/proc/123/status"],
        &[
            "-s",
            SERIAL,
            "shell",
            "-T",
            "cat",
            "/sys/class/power_supply/battery/uevent",
        ],
        &["-s", SERIAL, "shell", "-T", "dumpsys", "battery"],
        &["-s", SERIAL, "shell", "-T", "dumpsys", "thermalservice"],
        &["-s", SERIAL, "shell", "-T", "cat", "/proc/123/stat"],
        &["-s", SERIAL, "shell", "-T", "cat", "/proc/stat"],
    ];
    for (index, args) in commands.iter().enumerate() {
        assert_eq!(
            fixture.argv(index + 1),
            args.iter()
                .map(|part| (*part).to_owned())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            fs::read(
                fixture
                    .root
                    .join(format!("call-{:02}/restricted-flags.bin", index + 1))
            )
            .unwrap(),
            [0, 0, 0, 0]
        );
    }
    assert!(result.get("frame_window").is_none());
    assert!(result.get("fps").is_none());
    assert!(!scratch.exists());
}

#[test]
fn sample_preserves_optional_rss_and_lossy_comm_without_inventing_fps() {
    let fixture = Fixture::new("performance-optional-rss");
    let mut outputs = performance::outputs();
    outputs[2] = b"** MEMINFO in pid 123 [app] **\nTOTAL PSS: 42\n".to_vec();
    let name = outputs[1].iter().position(|byte| *byte == b'a').unwrap();
    outputs[1][name] = 0xff;
    performance::plan(&fixture, &outputs);
    let reply = performance::complete(&fixture, performance::request(&fixture), 9);
    assert_eq!(success(&reply)["rss_kib"], Value::Null);
    assert!(success(&reply).get("frame_window").is_none());
}

#[test]
fn sample_accepts_absent_artifact_context_and_legacy_underscore_package() {
    let fixture = Fixture::new("performance-no-context");
    performance::plan(&fixture, &performance::outputs());
    let mut request = performance::request(&fixture);
    request.as_object_mut().unwrap().remove("artifacts");
    request["input"]["input"]["package"] = json!("_app._worker");
    let reply = performance::complete(&fixture, request, 9);
    success(&reply);
    assert_eq!(fixture.argv(1).last().unwrap(), "_app._worker");
}

#[test]
fn sample_rejects_inputs_and_output_authorization_before_configuration() {
    for output in [false, true] {
        let fixture = Fixture::new("performance-no-artifact-grant");
        let mut request = performance::request(&fixture);
        let expected = if output {
            request["artifacts"]["output_directory"] = json!(fixture.root.join("unauthorized"));
            "输入无效：性能采样不接受产物输出授权"
        } else {
            request["artifacts"]["inputs"] = json!([{"field":"/input/package","artifact_id":"independent",
                "filename":"input.apk","size":1,"sha256":"0".repeat(64),"path":"unused"}]);
            "输入无效：该设备动作不接受输入产物"
        };
        fs::write(&fixture.config_path, b"must-not-read-invalid-config").unwrap();
        failure(&performance::complete(&fixture, request, 0), expected);
    }
}

#[test]
fn sample_input_rejects_unknown_paths_args_and_non_package_targets_before_config() {
    for (input, expected) in [
        (
            json!({"device_id":SERIAL,"input":{"package":PACKAGE},"source":"other"}),
            "输入无效：设备动作封套或业务字段不符合严格格式",
        ),
        (
            support::device(json!({"package":PACKAGE,"adb":"other"})),
            "输入无效：设备动作封套或业务字段不符合严格格式",
        ),
        (
            support::device(json!({"package":PACKAGE,"args":["--any"]})),
            "输入无效：设备动作封套或业务字段不符合严格格式",
        ),
        (
            support::device(json!({"package":PACKAGE,"interval_ms":1})),
            "输入无效：设备动作封套或业务字段不符合严格格式",
        ),
        (
            support::device(json!({"package":"com.app;id"})),
            "输入无效：性能目标必须为合法Android包名",
        ),
        (
            support::device(json!({"package":"1com.app"})),
            "输入无效：性能目标必须为合法Android包名",
        ),
        (
            json!({"device_id":null,"input":{"package":PACKAGE}}),
            "输入无效：设备动作的device_id必须为字符串",
        ),
        (
            json!({"device_id":SERIAL,"package":PACKAGE}),
            "输入无效：设备动作封套必须显式提供device_id和input",
        ),
    ] {
        let fixture = Fixture::new("performance-strict-input");
        let mut request = performance::request(&fixture);
        request["input"] = input;
        fs::write(&fixture.config_path, b"must-not-read-invalid-config").unwrap();
        failure(&performance::complete(&fixture, request, 0), expected);
    }
}

#[test]
fn sample_rejects_external_operation_name_before_config_or_tools() {
    let fixture = Fixture::new("performance-short-name-only");
    let mut request = performance::request(&fixture);
    request["operation"] = json!("plugin.android-device.performance.sample");
    fs::write(&fixture.config_path, b"must-not-read-invalid-config").unwrap();
    failure(
        &performance::complete(&fixture, request, 0),
        "输入无效：设备插件只接受已声明的短贡献名",
    );
}

#[test]
fn sample_identity_and_counter_errors_stop_without_partial_sample_or_next_call() {
    let cases = [
        (
            1,
            b"123 124\n".to_vec(),
            "工具依赖失败：性能输出包含非法计数",
        ),
        (1, b"0\n".to_vec(), "工具依赖失败：未找到唯一的应用进程"),
        (
            1,
            b"4294967296\n".to_vec(),
            "工具依赖失败：未找到唯一的应用进程",
        ),
        (
            2,
            performance::stat(124, 12, 900),
            "工具依赖失败：进程stat编号不匹配",
        ),
        (
            2,
            performance::stat(123, u64::MAX, 900),
            "工具依赖失败：进程CPU计数溢出",
        ),
        (
            3,
            b"** MEMINFO in pid 124 [app] **\nTOTAL PSS: 42\n".to_vec(),
            "工具依赖失败：内存进程编号不匹配或重复",
        ),
        (
            3,
            b"** MEMINFO in pid 123 [app] **\nTOTAL RSS: 42\n".to_vec(),
            "工具依赖失败：内存输出缺少TOTAL PSS",
        ),
        (
            3,
            b"** MEMINFO in pid 123 [app] **\nTOTAL 42 0\nTOTAL PSS: 43\n".to_vec(),
            "工具依赖失败：内存汇总互相矛盾",
        ),
        (
            8,
            performance::stat(123, 22, 901),
            "工具依赖失败：采样期间应用进程已重启",
        ),
        (
            9,
            b"cpu 1 2 3 4\ncpu0 0\ncpu0 0\n".to_vec(),
            "工具依赖失败：CPU核编号重复或数量超限",
        ),
        (
            9,
            b"cpu 18446744073709551615 1 0 0\ncpu0 0\n".to_vec(),
            "工具依赖失败：系统CPU计数溢出",
        ),
    ];
    for (stage, bytes, expected) in cases {
        let fixture = Fixture::new("performance-invalid-counter");
        let mut outputs = performance::outputs();
        outputs[stage - 1] = bytes;
        performance::plan(&fixture, &outputs);
        failure(
            &performance::complete(&fixture, performance::request(&fixture), stage),
            expected,
        );
    }
}

#[test]
fn sample_all_eight_failure_markers_in_either_stream_preempt_valid_data() {
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
        for stderr in [false, true] {
            let fixture = Fixture::new("performance-output-marker");
            let outputs = performance::outputs();
            performance::plan(&fixture, &outputs);
            fixture.plan(
                3,
                if stderr {
                    &outputs[2]
                } else {
                    marker.as_bytes()
                },
                if stderr { marker.as_bytes() } else { b"" },
                0,
            );
            failure(
                &performance::complete(&fixture, performance::request(&fixture), 3),
                performance::REJECTED,
            );
        }
    }
}

#[test]
fn sample_nonzero_exit_is_fixed_failure_and_stops_remaining_commands() {
    let fixture = Fixture::new("performance-nonzero");
    performance::plan(&fixture, &performance::outputs());
    fixture.plan(
        2,
        b"123 (app) S 0",
        b"private diagnostic must not escape",
        7,
    );
    failure(
        &performance::complete(&fixture, performance::request(&fixture), 2),
        "工具依赖失败：设备连接工具执行失败，目前无法确认具体原因，请查看任务详情",
    );
}

#[test]
fn sample_each_stream_limit_is_enforced_and_direct_pid_confirmed() {
    for stderr in [false, true] {
        let fixture = Fixture::new("performance-output-limit");
        let bytes = vec![b'x'; 1024 * 1024 + 1];
        fixture.plan(
            1,
            if stderr { b"" } else { &bytes },
            if stderr { &bytes } else { b"" },
            0,
        );
        let mut running = fixture.begin_request(performance::request(&fixture));
        running.start(Duration::from_secs(20));
        let probe = fixture.wait_tool(1);
        fixture.release(1);
        failure(&running.complete(), "数据超过插件限额");
        probe.assert_exited();
        fixture.assert_calls(1);
    }
}

#[test]
fn sample_exact_one_mib_per_stream_is_accepted_without_a_combined_limit() {
    let fixture = Fixture::new("performance-output-boundary");
    performance::plan(&fixture, &performance::outputs());
    let mut stdout = b"123\n".to_vec();
    stdout.resize(1024 * 1024, b' ');
    let stderr = vec![b' '; 1024 * 1024];
    fixture.plan(1, &stdout, &stderr, 0);
    success(&performance::complete(
        &fixture,
        performance::request(&fixture),
        9,
    ));
}

#[test]
fn sample_cancel_at_each_base_or_optional_tool_confirms_direct_pid_and_no_late_result() {
    for stage in 1..=9 {
        let fixture = Fixture::new("performance-cancel-stage");
        performance::plan(&fixture, &performance::outputs());
        let mut running = fixture.begin_request(performance::request(&fixture));
        running.start(Duration::from_secs(20));
        for index in 1..stage {
            performance::release(&fixture, index);
        }
        let probe = fixture.wait_tool(stage);
        running.cancel("cancelled");
        failure(&running.complete(), CANCELLED);
        probe.assert_exited();
        fixture.assert_calls(stage);
        assert!(!fixture.root.join(format!("release-{stage}")).exists());
    }
}

#[test]
fn sample_stdin_eof_cancels_meminfo_before_stat_confirmation() {
    let fixture = Fixture::new("performance-eof");
    performance::plan(&fixture, &performance::outputs());
    let mut running = fixture.begin_request(performance::request(&fixture));
    running.start(Duration::from_secs(20));
    performance::release(&fixture, 1);
    performance::release(&fixture, 2);
    let probe = fixture.wait_tool(3);
    running.eof();
    failure(&running.complete(), CANCELLED);
    probe.assert_exited();
    fixture.assert_calls(3);
    assert!(!fixture.root.join("release-3").exists());
}

#[test]
fn sample_original_deadline_stops_a_later_tool_without_resetting_budget() {
    let fixture = Fixture::new("performance-total-deadline");
    performance::plan(&fixture, &performance::outputs());
    let mut running = fixture.begin_request(performance::request(&fixture));
    running.start(Duration::from_secs(5));
    performance::release(&fixture, 1);
    performance::release(&fixture, 2);
    let probe = fixture.wait_tool(3);
    failure(&running.complete(), TOTAL_TIMEOUT);
    probe.assert_exited();
    fixture.assert_calls(3);
    assert!(!fixture.root.join("release-3").exists());
}

#[test]
fn sample_zero_budget_and_queued_cancel_are_zero_io_before_config() {
    for cancel in [false, true] {
        let fixture = Fixture::new("performance-zero-io");
        fs::write(&fixture.config_path, b"must-not-read-invalid-config").unwrap();
        let mut running = fixture.begin_request(performance::request(&fixture));
        if cancel {
            running.send_batch(&[
                running.start_frame(Duration::from_secs(20)),
                running.cancel_frame("cancelled"),
            ]);
        } else {
            running.start(Duration::ZERO);
        }
        failure(
            &running.complete(),
            if cancel { CANCELLED } else { TOTAL_TIMEOUT },
        );
        fixture.assert_no_tool();
    }
}

#[test]
fn sample_delayed_start_consumes_the_original_protocol_origin() {
    let fixture = Fixture::new("performance-delayed-start");
    let mut running = fixture.begin_request(performance::request(&fixture));
    thread::sleep(Duration::from_millis(500));
    running.start(Duration::from_millis(200));
    failure(&running.complete(), TOTAL_TIMEOUT);
    fixture.assert_no_tool();
}

#[test]
fn sample_exact_metric_denials_and_unsupported_keep_the_other_base_metrics() {
    for (stage, key, source, diagnostic, reason) in [
        (
            3,
            "memory",
            "android_dumpsys.meminfo",
            "dumpsys: meminfo: Permission denied\n",
            "permission_denied",
        ),
        (
            3,
            "memory",
            "android_dumpsys.meminfo",
            "dumpsys: meminfo: not supported\n",
            "unsupported",
        ),
        (
            9,
            "cpu",
            "linux_proc.stat",
            "cat: /proc/stat: Permission denied\n",
            "permission_denied",
        ),
        (
            9,
            "cpu",
            "linux_proc.stat",
            "cat: /proc/stat: Operation not supported\n",
            "unsupported",
        ),
    ] {
        for code in [0, 1] {
            let fixture = Fixture::new("performance-explicit-partial-metric");
            let outputs = performance::outputs();
            performance::plan(&fixture, &outputs);
            fixture.plan(
                stage,
                // 非零工具错误不保留stdout；即使曾输出计数也只发布缺测，不复用它们。
                if code == 0 {
                    diagnostic.as_bytes()
                } else {
                    &outputs[stage - 1]
                },
                if code == 1 {
                    diagnostic.as_bytes()
                } else {
                    b""
                },
                code,
            );
            let reply = performance::complete(&fixture, performance::request(&fixture), 9);
            let result = success(&reply);
            assert_eq!(result["pid"], 123);
            assert_eq!(result["process_start_ticks"], 900);
            assert_eq!(result["process_ticks"], 30);
            assert_eq!(result["metric_missing"]["api_version"], 1);
            assert_eq!(
                result["metric_missing"][key],
                json!({
                    "source": source, "access": "adb_shell", "reason": reason,
                })
            );
            if key == "memory" {
                assert_eq!(result["pss_kib"], Value::Null);
                assert_eq!(result["rss_kib"], Value::Null);
                assert_eq!(result["system_ticks"], 137);
                assert_eq!(result["logical_cpus"], 2);
                assert!(result["metric_missing"].get("cpu").is_none());
            } else {
                assert_eq!(result["system_ticks"], Value::Null);
                assert_eq!(result["logical_cpus"], Value::Null);
                assert_eq!(result["pss_kib"], 42);
                assert_eq!(result["rss_kib"], 84);
                assert!(result["metric_missing"].get("memory").is_none());
            }
            for index in 1..=9 {
                assert_eq!(
                    fs::read_to_string(
                        fixture
                            .root
                            .join(format!("call-{index:02}/normal-exit-code"))
                    )
                    .unwrap(),
                    if index == stage {
                        code.to_string()
                    } else {
                        "0".into()
                    }
                );
            }
        }
    }
}

#[test]
fn sample_missing_cpu_and_memory_keep_qualified_environment_without_reusing_values() {
    let fixture = Fixture::new("performance-both-metrics-missing");
    let mut outputs = performance::outputs();
    outputs[4] = b"POWER_SUPPLY_NAME=battery\nPOWER_SUPPLY_TYPE=Battery\nPOWER_SUPPLY_PRESENT=1\nPOWER_SUPPLY_STATUS=Discharging\nPOWER_SUPPLY_VOLTAGE_NOW=4000000\nPOWER_SUPPLY_CURRENT_NOW=-500000\nPOWER_SUPPLY_TEMP=305\n".to_vec();
    outputs[5] = b"Current Battery Service state:\n AC powered: false\n USB powered: false\n Wireless powered: false\n Dock powered: false\n present: true\n status: 3\n voltage: 4000\n temperature: 305\n".to_vec();
    outputs[6] = b"HAL Ready: true\nCurrent temperatures from HAL:\nTemperature{mValue=47.25, mType=1, mName=gpu, mStatus=0}\nCurrent cooling devices from HAL:\n".to_vec();
    performance::plan(&fixture, &outputs);
    fixture.plan(3, b"", b"dumpsys: meminfo: Permission denied\n", 1);
    fixture.plan(9, b"", b"cat: /proc/stat: Operation not supported\n", 1);
    let reply = performance::complete(&fixture, performance::request(&fixture), 9);
    let result = success(&reply);
    for key in ["system_ticks", "logical_cpus", "pss_kib", "rss_kib"] {
        assert_eq!(result[key], Value::Null);
    }
    assert_eq!(result["process_ticks"], 30);
    assert_eq!(result["metric_missing"]["cpu"]["reason"], "unsupported");
    assert_eq!(
        result["metric_missing"]["memory"]["reason"],
        "permission_denied"
    );
    let observation = &result["device_observation"];
    assert_eq!(observation["device_id"], SERIAL);
    assert_eq!(observation["battery"]["voltage_uv"], 4_000_000);
    assert_eq!(observation["battery"]["current_ua"], -500_000);
    assert_eq!(
        observation["temperatures"][0]["temperature_celsius"],
        json!(47.25)
    );
    assert_eq!(observation["temperatures"][0]["sensor_kind"], "gpu");
}

#[test]
fn sample_unknown_wrong_exit_and_mixed_metric_diagnostics_remain_hard_failures() {
    for (stage, diagnostic) in [
        (3, "dumpsys: meminfo: Permission denied\n"),
        (3, "dumpsys: meminfo: not supported\n"),
        (9, "cat: /proc/stat: Permission denied\n"),
        (9, "cat: /proc/stat: Operation not supported\n"),
    ] {
        for mixed in [false, true] {
            let fixture = Fixture::new("performance-refuses-unsafe-downgrade");
            let outputs = performance::outputs();
            performance::plan(&fixture, &outputs);
            fixture.plan(
                stage,
                if mixed { &outputs[stage - 1] } else { b"" },
                diagnostic.as_bytes(),
                if mixed { 0 } else { 2 },
            );
            failure(
                &performance::complete(&fixture, performance::request(&fixture), stage),
                if mixed {
                    performance::REJECTED
                } else {
                    "工具依赖失败：设备连接工具执行失败，目前无法确认具体原因，请查看任务详情"
                },
            );
        }
    }
    for stage in [3, 9] {
        for diagnostic in [
            "Permission Denied",
            "unsupported",
            "device offline",
            "unauthorized",
            "cat: /proc/stat: Permission denied extra",
        ] {
            let fixture = Fixture::new("performance-unknown-nonzero-diagnostic");
            performance::plan(&fixture, &performance::outputs());
            fixture.plan(stage, b"", diagnostic.as_bytes(), 1);
            failure(
                &performance::complete(&fixture, performance::request(&fixture), stage),
                "工具依赖失败：设备连接工具执行失败，目前无法确认具体原因，请查看任务详情",
            );
        }
    }
}

#[test]
fn sample_partial_memory_does_not_weaken_later_identity_or_cancellation() {
    for cancel in [false, true] {
        let fixture = Fixture::new("performance-partial-before-final-guard");
        performance::plan(&fixture, &performance::outputs());
        fixture.plan(3, b"", b"dumpsys: meminfo: Permission denied\n", 1);
        if !cancel {
            fixture.plan(8, &performance::stat(123, 22, 901), b"", 0);
            failure(
                &performance::complete(&fixture, performance::request(&fixture), 8),
                "工具依赖失败：采样期间应用进程已重启",
            );
            continue;
        }
        let mut running = fixture.begin_request(performance::request(&fixture));
        running.start(Duration::from_secs(20));
        for index in 1..9 {
            performance::release(&fixture, index);
        }
        let probe = fixture.wait_tool(9);
        running.cancel("cancelled");
        failure(&running.complete(), CANCELLED);
        probe.assert_exited();
        fixture.assert_calls(9);
        assert!(!fixture.root.join("release-9").exists());
    }
}
