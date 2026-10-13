use crate::support::{CANCELLED, Fixture, TOTAL_TIMEOUT, artifacts, failure, success};
use serde_json::{Value, json};
use std::{
    fs, thread,
    time::{Duration, Instant},
};

const ADDRESS: &str = "localhost:5555";
const CONNECT: &[u8] = b"Connect OK\n";
const REPEAT: &[u8] = b"[Info]Target is connected, repeat operation\n";

fn provider(input: Value) -> Value {
    json!({"device_id":null,"input":input})
}

fn action(address: &str) -> Value {
    provider(json!({"address":address}))
}

fn assert_client_only(fixture: &Fixture, operation: &str, address: &str) {
    let expected = if operation == "connect" {
        vec!["tconn", address]
    } else {
        vec!["tconn", address, "-remove"]
    };
    assert_eq!(fixture.argv(), expected);
    fixture.assert_calls(1);
    assert!(!fixture.root.join("unused-output").exists());
    assert!(!fixture.root.join("call-02").exists());
}

#[test]
fn connect_new_and_repeat_results_preserve_complete_text_from_both_streams() {
    for (stdout, stderr, output) in [
        (CONNECT, b"".as_slice(), "Connect OK"),
        (b"".as_slice(), CONNECT, "Connect OK"),
        (
            REPEAT,
            b"".as_slice(),
            "[Info]Target is connected, repeat operation",
        ),
        (
            b"".as_slice(),
            REPEAT,
            "[Info]Target is connected, repeat operation",
        ),
        (
            b" \r\nConnect OK\r\n".as_slice(),
            b" \t\r\n".as_slice(),
            "Connect OK",
        ),
        (
            b"[Info]attempt\nConnect OK\n".as_slice(),
            b"[Info]complete\n".as_slice(),
            "[Info]attempt\nConnect OK\n\n[Info]complete",
        ),
    ] {
        let fixture = Fixture::new("network-connect-success");
        let reply = fixture.run("connect", action(ADDRESS), stdout, stderr, 0);
        assert_eq!(success(&reply), &json!({"output":output}));
        assert_client_only(&fixture, "connect", ADDRESS);
        assert_eq!(
            fs::read(fixture.root.join("call-01/normal-exit-code")).unwrap(),
            b"0"
        );
    }
}

#[test]
fn disconnect_accepts_only_zero_exit_and_whitespace_in_both_streams() {
    for (stdout, stderr) in [
        (b"".as_slice(), b"".as_slice()),
        (b" \r\n\t".as_slice(), b"\t \r\n".as_slice()),
    ] {
        let mut fixture = Fixture::new("network-disconnect-silent");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let reply = fixture.run("disconnect", action(ADDRESS), stdout, stderr, 0);
        assert_eq!(success(&reply), &json!({"output":""}));
        assert_client_only(&fixture, "disconnect", ADDRESS);
        artifacts::empty(&scratch);
    }
}

#[test]
fn both_network_actions_preserve_ipv4_and_localhost_port_boundaries() {
    for operation in ["connect", "disconnect"] {
        for address in [
            "0.0.0.0:1",
            "127.0.0.1:65535",
            "255.255.255.255:65535",
            "localhost:00001",
        ] {
            let fixture = Fixture::new("network-address-literal");
            let stdout = if operation == "connect" { CONNECT } else { b"" };
            let reply = fixture.run(operation, action(address), stdout, b"", 0);
            assert_eq!(
                success(&reply),
                &json!({"output":if operation == "connect" { "Connect OK" } else { "" }})
            );
            assert_client_only(&fixture, operation, address);
            assert_eq!(
                fs::read(fixture.root.join("call-01/restricted-flags.bin")).unwrap(),
                [0, 0, 0, 0]
            );
        }
    }
}

#[test]
fn network_envelopes_require_both_fields_and_explicit_null_before_configuration() {
    for operation in ["connect", "disconnect"] {
        for input in [
            json!(null),
            json!([]),
            json!({"input":{"address":ADDRESS}}),
            json!({"device_id":null}),
        ] {
            let fixture = Fixture::new("network-missing-envelope-field");
            fs::write(&fixture.config_path, b"invalid configuration").unwrap();
            fixture.reject(
                fixture.request(operation, input),
                "输入无效：设备动作封套必须显式提供device_id和input",
            );
        }
        for device_id in [
            json!(""),
            json!(ADDRESS),
            json!(7),
            json!(false),
            json!([]),
            json!({}),
        ] {
            let fixture = Fixture::new("network-non-null-device");
            fs::write(&fixture.config_path, b"invalid configuration").unwrap();
            fixture.reject(
                fixture.request(
                    operation,
                    json!({"device_id":device_id,"input":{"address":ADDRESS}}),
                ),
                "输入无效：连接管理封套device_id必须为显式null",
            );
        }
        let fixture = Fixture::new("network-unknown-envelope-field");
        fs::write(&fixture.config_path, b"invalid configuration").unwrap();
        fixture.reject(
            fixture.request(
                operation,
                json!({"device_id":null,"input":{"address":ADDRESS},"extra":true}),
            ),
            "输入无效：设备动作封套或业务字段不符合严格格式",
        );
    }
}

#[test]
fn network_business_accepts_only_address_object_before_configuration() {
    for operation in ["connect", "disconnect"] {
        for input in [json!(null), json!([]), json!(ADDRESS)] {
            let fixture = Fixture::new("network-non-object-business");
            fs::write(&fixture.config_path, b"invalid configuration").unwrap();
            fixture.reject(
                fixture.request(operation, provider(input)),
                "输入无效：连接管理业务输入必须为对象",
            );
        }
        for input in [
            json!({}),
            json!({"address":null}),
            json!({"address":7}),
            json!({"address":ADDRESS,"port":5555}),
            json!({"address":ADDRESS,"deviceId":"HDC001"}),
            json!({"address":ADDRESS,"argv":["kill"]}),
            json!({"address":ADDRESS,"command":"tconn"}),
            json!({"address":ADDRESS,"tool_path":"private"}),
            json!({"address":ADDRESS,"extra":true}),
        ] {
            let fixture = Fixture::new("network-unknown-business-field");
            fs::write(&fixture.config_path, b"invalid configuration").unwrap();
            fixture.reject(
                fixture.request(operation, provider(input)),
                "输入无效：连接管理业务字段不符合严格格式",
            );
        }
    }
}

#[test]
fn network_rejects_noncanonical_hosts_ports_and_injection_before_configuration() {
    for operation in ["connect", "disconnect"] {
        for (addresses, expected) in [
            (
                vec!["255.255.255.255:065535", "本机:5555", "localhost:１２"],
                "输入无效：连接地址须为最多21字节的IPv4或localhost及端口",
            ),
            (
                vec!["", "127.0.0.1", "localhost", "-flag"],
                "输入无效：连接地址必须显式包含主机和端口",
            ),
            (
                vec![
                    "127.1:5555",
                    "256.0.0.1:5555",
                    "127.00.0.1:5555",
                    "0x7f.0.0.1:5555",
                    "example.com:5555",
                    "LOCALHOST:5555",
                    "[::1]:5555",
                    "::1:5555",
                    " localhost:5555",
                    "localhost\n:5555",
                    "-localhost:5555",
                    "localhost;id:5555",
                ],
                "输入无效：连接主机须为规范IPv4或字面localhost",
            ),
            (
                vec![
                    "localhost:",
                    "localhost:0",
                    "localhost:65536",
                    "localhost:000001",
                    "localhost:+1",
                    "localhost:-1",
                    "localhost:0x10",
                    "localhost:1.0",
                    "localhost:5555 ",
                    "localhost:55\n55",
                    "localhost:5555;id",
                    "localhost:5555:1",
                ],
                "输入无效：连接端口须为1至65535的ASCII十进制数字",
            ),
        ] {
            for address in addresses {
                let fixture = Fixture::new("network-invalid-address");
                fs::write(&fixture.config_path, b"invalid configuration").unwrap();
                fixture.reject(fixture.request(operation, action(address)), expected);
            }
        }
    }
}

#[test]
fn failure_diagnostics_in_either_stream_override_connect_or_silent_disconnect() {
    for operation in ["connect", "disconnect"] {
        let valid = if operation == "connect" {
            "Connect OK"
        } else {
            ""
        };
        for diagnostic in [
            "[Fail]No target available",
            "[fAiL]private diagnostic",
            "error: private diagnostic",
            "device offline",
        ] {
            for stderr_diagnostic in [false, true] {
                let fixture = Fixture::new("network-diagnostic-wins");
                let (stdout, stderr) = if stderr_diagnostic {
                    (valid.to_owned(), diagnostic.to_owned())
                } else {
                    (format!("{valid}\n{diagnostic}"), String::new())
                };
                failure(
                    &fixture.run(
                        operation,
                        action(ADDRESS),
                        stdout.as_bytes(),
                        stderr.as_bytes(),
                        0,
                    ),
                    "工具依赖失败：HDC返回失败诊断",
                );
                assert_client_only(&fixture, operation, ADDRESS);
            }
        }
    }
}

#[test]
fn connect_requires_own_case_sensitive_complete_success_line() {
    for stdout in [
        b"".as_slice(),
        b"Success\n".as_slice(),
        b"connected to localhost:5555\n".as_slice(),
        b"connect ok\n".as_slice(),
        b"CONNECT OK\n".as_slice(),
        b"prefix Connect OK\n".as_slice(),
        b"Connect OK suffix\n".as_slice(),
        b"[info]Target is connected, repeat operation\n".as_slice(),
        b"[Info]Target is connected, repeat operation suffix\n".as_slice(),
        b"msg:install bundle successfully.\n".as_slice(),
    ] {
        let fixture = Fixture::new("network-connect-unknown-response");
        failure(
            &fixture.run("connect", action(ADDRESS), stdout, b"", 0),
            "工具依赖失败：HDC未返回明确连接成功结果",
        );
        assert_client_only(&fixture, "connect", ADDRESS);
    }
}

#[test]
fn disconnect_rejects_all_unknown_nonempty_responses_from_either_stream() {
    for output in [
        CONNECT,
        REPEAT,
        b"Disconnect OK\n".as_slice(),
        b"Success\n".as_slice(),
    ] {
        for stderr_response in [false, true] {
            let fixture = Fixture::new("network-disconnect-nonempty");
            let (stdout, stderr) = if stderr_response {
                (b"".as_slice(), output)
            } else {
                (output, b"".as_slice())
            };
            failure(
                &fixture.run("disconnect", action(ADDRESS), stdout, stderr, 0),
                "工具依赖失败：HDC断开返回不支持的非静默响应",
            );
            assert_client_only(&fixture, "disconnect", ADDRESS);
        }
    }
}

#[test]
fn both_network_actions_reject_utf8_errors_nonzero_exits_and_each_stream_limit() {
    for operation in ["connect", "disconnect"] {
        let valid = if operation == "connect" { CONNECT } else { b"" };
        for (stdout, stderr, code, expected) in [
            (
                &[0xff][..],
                b"".as_slice(),
                0,
                "工具依赖失败：HDC输出不是有效UTF-8",
            ),
            (valid, &[0xff][..], 0, "工具依赖失败：HDC输出不是有效UTF-8"),
            (
                valid,
                b"".as_slice(),
                7,
                "工具依赖失败：HDC客户端执行失败，请检查部署配置",
            ),
        ] {
            let fixture = Fixture::new("network-stream-failure");
            failure(
                &fixture.run(operation, action(ADDRESS), stdout, stderr, code),
                expected,
            );
            assert_client_only(&fixture, operation, ADDRESS);
        }
        for oversized_stderr in [false, true] {
            let fixture = Fixture::new("network-stream-limit");
            let oversized = vec![b'x'; 1024 * 1024 + 1];
            let (stdout, stderr) = if oversized_stderr {
                (valid, oversized.as_slice())
            } else {
                (oversized.as_slice(), b"".as_slice())
            };
            failure(
                &fixture.run(operation, action(ADDRESS), stdout, stderr, 0),
                "数据超过插件限额",
            );
            assert_client_only(&fixture, operation, ADDRESS);
        }
    }
}

#[test]
fn network_actions_reject_input_artifacts_before_configuration_or_copying() {
    for operation in ["connect", "disconnect"] {
        let mut fixture = Fixture::new("network-no-input-artifact");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let mut request = artifacts::installation(&fixture, b"unchanged authorized source");
        request["operation"] = json!(operation);
        request["input"] = action(ADDRESS);
        fs::write(&fixture.config_path, b"invalid configuration").unwrap();
        fixture.reject(request, "输入无效：该设备动作不接受输入产物");
        artifacts::empty(&scratch);
        assert_eq!(
            fs::read(fixture.root.join("authorized-source.hap")).unwrap(),
            b"unchanged authorized source"
        );
    }
}

#[test]
fn network_precancel_and_zero_budget_have_no_configuration_or_tool_effects() {
    for operation in ["connect", "disconnect"] {
        for zero_budget in [false, true] {
            let fixture = Fixture::new("network-control-before-start");
            fs::write(&fixture.config_path, b"invalid configuration").unwrap();
            let mut running = fixture.begin(operation, action(ADDRESS));
            if zero_budget {
                running.start(Duration::ZERO);
            } else {
                running.send_batch(&[
                    running.start_frame(Duration::from_secs(20)),
                    running.cancel_frame("cancelled"),
                ]);
            }
            failure(
                &running.complete(),
                if zero_budget {
                    TOTAL_TIMEOUT
                } else {
                    CANCELLED
                },
            );
            fixture.assert_calls(0);
            assert!(!fixture.root.join("unused-output").exists());
        }
    }
}

#[test]
fn network_delayed_start_with_expired_original_budget_never_runs_hdc() {
    for operation in ["connect", "disconnect"] {
        let fixture = Fixture::new("network-expired-before-start");
        fs::write(&fixture.config_path, b"invalid configuration").unwrap();
        let mut running = fixture.begin(operation, action(ADDRESS));
        thread::sleep(Duration::from_millis(500));
        running.start(Duration::from_millis(200));
        failure(&running.complete(), TOTAL_TIMEOUT);
        fixture.assert_calls(0);
        assert!(!fixture.root.join("unused-output").exists());
    }
}

#[test]
fn each_running_network_action_cancels_eof_or_times_out_without_compensation() {
    for operation in ["connect", "disconnect"] {
        for mode in ["cancel", "eof", "deadline"] {
            let mut fixture = Fixture::new("network-running-control");
            let scratch = artifacts::configure_scratch(&mut fixture);
            fixture.plan(if operation == "connect" { CONNECT } else { b"" }, b"", 0);
            let mut running = fixture.begin(operation, action(ADDRESS));
            running.start(if mode == "deadline" {
                Duration::from_secs(3)
            } else {
                Duration::from_secs(20)
            });
            let probe = fixture.wait_tool();
            let control_origin = Instant::now();
            match mode {
                "cancel" => running.cancel("cancelled"),
                "eof" => running.eof(),
                "deadline" => {}
                _ => unreachable!(),
            }
            failure(
                &running.complete(),
                if mode == "deadline" {
                    TOTAL_TIMEOUT
                } else {
                    CANCELLED
                },
            );
            if mode != "deadline" {
                assert!(control_origin.elapsed() < Duration::from_secs(3));
            }
            probe.assert_exited();
            assert_client_only(&fixture, operation, ADDRESS);
            assert!(!fixture.root.join("release").exists());
            assert!(!fixture.root.join("call-01/release-observed.bin").exists());
            assert!(!fixture.root.join("call-01/normal-exit-code").exists());
            artifacts::empty(&scratch);
        }
    }
}

#[test]
fn network_tool_phase_consumes_ready_wait_in_original_deadline() {
    for operation in ["connect", "disconnect"] {
        let fixture = Fixture::new("network-original-tool-budget");
        fixture.plan(if operation == "connect" { CONNECT } else { b"" }, b"", 0);
        let mut running = fixture.begin(operation, action(ADDRESS));
        thread::sleep(Duration::from_secs(2));
        running.start(Duration::from_secs(4));
        let probe = fixture.wait_tool();
        thread::sleep(Duration::from_millis(2600));
        fixture.release();
        failure(&running.complete(), TOTAL_TIMEOUT);
        probe.assert_exited();
        assert_client_only(&fixture, operation, ADDRESS);
        assert!(!fixture.root.join("call-01/release-observed.bin").exists());
        assert!(!fixture.root.join("call-01/normal-exit-code").exists());
    }
}
