use crate::support::{
    CANCELLED, Fixture, Invocation, PidProbe, SERIAL, TOTAL_TIMEOUT, expected_device, failure,
    success,
};
use serde_json::{Value, json};
use std::{
    fs, thread,
    time::{Duration, Instant},
};

const VERSION: &[u8] = b"5.0.1.1\n\nDF_INPUT_DONE:{{TOKEN}}:version:0\n";
const HELP: &[u8] = b"click/doubleClick/longClick <x> <y> click on the target coordinates\nswipe/drag <from_x> <from_y> <to_x> <to_y> [velocity] velocity ranges from 200 to 40000, default 600\nkeyEvent <keyID/Back/Home/Power> inject keyEvent\ninputText <x> <y> <text> inputText at the target coordinate point\n\nDF_INPUT_DONE:{{TOKEN}}:help:0\n";
const ACTION: &[u8] = b"No Error\n\nDF_INPUT_DONE:{{TOKEN}}:{{STAGE}}:0\n";
const UNKNOWN: &str = "插件资源清理未确认";
const STRICT: &str = "输入无效：Harmony输入动作字段不符合严格格式";

struct Input {
    fixture: Fixture,
    request: Value,
}

impl Input {
    fn new(label: &str, action: Value) -> Self {
        let fixture = Fixture::new(label);
        fs::write(fixture.root.join("input-fixture"), b"1").unwrap();
        let request = fixture.request(
            "input",
            json!({"device_id":SERIAL,"input":{"action":action}}),
        );
        Self { fixture, request }
    }
    fn plan(
        &self,
        ordinal: usize,
        stage: &str,
        command: &str,
        response: (&[u8], &[u8], i32),
        serial: &str,
    ) {
        let (stdout, stderr, code) = response;
        self.fixture.plan_call(ordinal, stdout, stderr, code);
        let root = self.fixture.root.join(format!("plan-{ordinal:02}"));
        fs::write(root.join("input-stage"), stage).unwrap();
        fs::write(root.join("input-command"), command).unwrap();
        fs::write(root.join("input-serial"), serial).unwrap();
    }
    fn qualify(&self) {
        self.plan(1, "version", "uitest --version", (VERSION, b"", 0), SERIAL);
        self.plan(2, "help", "uitest help", (HELP, b"", 0), SERIAL);
    }
    fn normal(&self, command: &str, enter: bool) {
        self.qualify();
        self.plan(3, "action", command, (ACTION, b"", 0), SERIAL);
        if enter {
            self.plan(
                4,
                "enter",
                "uitest uiInput keyEvent 2054",
                (ACTION, b"", 0),
                SERIAL,
            );
        }
    }
    fn begin(&self, remaining: Duration) -> Invocation {
        let mut running = self.fixture.begin_request(self.request.clone());
        running.start(remaining);
        running
    }
    fn release(&self, ordinal: usize) -> PidProbe {
        let probe = self.fixture.wait_tool_at(ordinal);
        assert_eq!(
            fs::read(
                self.fixture
                    .root
                    .join(format!("call-{ordinal:02}/input-argv-verified"))
            )
            .unwrap(),
            b"1"
        );
        assert_eq!(
            fs::read(
                self.fixture
                    .root
                    .join(format!("call-{ordinal:02}/restricted-flags.bin"))
            )
            .unwrap(),
            [0, 0, 0, 0]
        );
        self.fixture.release_call(ordinal);
        probe
    }
    fn run(&self, calls: usize) -> Value {
        let running = self.begin(Duration::from_secs(20));
        let probes: Vec<_> = (1..=calls).map(|ordinal| self.release(ordinal)).collect();
        let reply = running.complete();
        for probe in probes {
            probe.assert_exited();
        }
        self.fixture.assert_calls(calls);
        assert!(!self.fixture.root.join("unused-output").exists());
        reply
    }
    fn replace(&self, ordinal: usize, stdout: &[u8], stderr: &[u8], code: i32) {
        let root = self.fixture.root.join(format!("plan-{ordinal:02}"));
        fs::write(root.join("stdout"), stdout).unwrap();
        fs::write(root.join("stderr"), stderr).unwrap();
        fs::write(root.join("code"), code.to_string()).unwrap();
    }
}

fn failed(reply: &Value, error: &str) {
    assert_eq!(reply["cleanup"], "failed");
    assert_eq!(reply["response"]["error"], error);
    assert!(reply["response"].get("result").is_none());
    assert!(reply["response"].get("outputs").is_none());
}

fn unknown(reply: &Value) {
    failed(reply, UNKNOWN);
}

fn tap() -> Value {
    json!({"kind":"tap","x":1,"y":32767})
}

fn reject(action: Value, expected: &str) {
    let input = Input::new("input-invalid", action);
    input.fixture.reject(input.request, expected);
}

#[test]
fn input_four_actions_requalify_and_use_exact_independent_argv() {
    for (action, command, kind) in [
        (tap(), "uitest uiInput click 1 32767", "tap"),
        (
            json!({"kind":"swipe","x1":1,"y1":2,"x2":32767,"y2":3}),
            "uitest uiInput swipe 1 2 32767 3 600",
            "swipe",
        ),
        (
            json!({"kind":"swipe","x1":1,"y1":2,"x2":3,"y2":4,"velocity_pps":200}),
            "uitest uiInput swipe 1 2 3 4 200",
            "swipe",
        ),
        (
            json!({"kind":"swipe","x1":1,"y1":2,"x2":3,"y2":4,"velocity_pps":40000}),
            "uitest uiInput swipe 1 2 3 4 40000",
            "swipe",
        ),
        (
            json!({"kind":"keyevent","key_code":2054}),
            "uitest uiInput keyEvent 2054",
            "keyevent",
        ),
        (
            json!({"kind":"text","x":2,"y":3,"text":"中文"}),
            "uitest uiInput inputText 2 3 '中文'",
            "text",
        ),
    ] {
        let input = Input::new("input-four-actions", action);
        input.normal(command, false);
        assert_eq!(
            success(&input.run(3)),
            &json!({"device_id":SERIAL,"action":kind,"dispatched":true})
        );
        let version = fs::read_to_string(input.fixture.root.join("call-01/input-token")).unwrap();
        let help = fs::read_to_string(input.fixture.root.join("call-02/input-token")).unwrap();
        let action = fs::read_to_string(input.fixture.root.join("call-03/input-token")).unwrap();
        assert_eq!(version, help);
        assert_ne!(help, action);
    }
}

#[test]
fn input_text_preserves_shell_literals_and_optional_enter_is_native_2054() {
    let input = Input::new(
        "input-text-literals",
        json!({"kind":"text","x":1,"y":2,"text":"中文 space %s % ' $ ` ","enter":true}),
    );
    input.normal(
        "uitest uiInput inputText 1 2 '中文 space %s % '\\'' $ ` '",
        true,
    );
    assert_eq!(
        success(&input.run(4)),
        &json!({"device_id":SERIAL,"action":"text","dispatched":true})
    );
    assert_eq!(
        fs::read(input.fixture.root.join("call-03/input-token")).unwrap(),
        fs::read(input.fixture.root.join("call-04/input-token")).unwrap()
    );
}

#[test]
fn input_text_exact_1024_utf8_bytes_and_false_enter_dispatch_once() {
    let text = "界".repeat(341) + "x";
    assert_eq!(text.len(), 1024);
    let input = Input::new(
        "input-text-byte-boundary",
        json!({"kind":"text","x":1,"y":2,"text":text,"enter":false}),
    );
    input.normal(&format!("uitest uiInput inputText 1 2 '{text}'"), false);
    assert_eq!(success(&input.run(3))["action"], "text");
}

#[test]
fn input_strict_three_layers_reject_unknown_fields_and_bad_shapes_without_tools() {
    for (envelope, expected) in [
        (
            json!({"device_id":SERIAL,"input":{"action":tap()},"extra":true}),
            "输入无效：设备动作封套或业务字段不符合严格格式",
        ),
        (
            json!({"device_id":SERIAL,"input":{"action":tap(),"extra":true}}),
            STRICT,
        ),
        (
            json!({"device_id":SERIAL,"input":{"action":{"kind":"tap","x":1,"y":2,"extra":true}}}),
            STRICT,
        ),
        (
            json!({"device_id":SERIAL,"input":{"action":null}}),
            "输入无效：Harmony输入和action须为显式对象",
        ),
        (
            json!({"device_id":SERIAL,"input":[]}),
            "输入无效：Harmony输入和action须为显式对象",
        ),
        (
            json!({"device_id":SERIAL}),
            "输入无效：设备动作封套必须显式提供device_id和input",
        ),
        (
            json!({"device_id":null,"input":{"action":tap()}}),
            "输入无效：设备动作封套或业务字段不符合严格格式",
        ),
    ] {
        let input = Input::new("input-strict-envelope", tap());
        input
            .fixture
            .reject(input.fixture.request("input", envelope), expected);
    }
    for action in [
        json!({"kind":"android"}),
        json!({"kind":"tap","x":1.0,"y":2}),
        json!({"kind":"tap","x":-1,"y":2}),
        json!({"kind":"tap","x":4294967296u64,"y":2}),
        json!({"kind":"tap","x":"1","y":2}),
        json!({"kind":"tap","x":true,"y":2}),
        json!({"kind":"tap","x":1}),
        json!({"kind":"swipe","x1":1,"y1":2,"x2":3,"y2":4,"duration_ms":100}),
        json!({"kind":"keyevent","key_code":2054,"long_press":false}),
        json!({"kind":"text","text":"value"}),
        json!({"kind":"text","x":1,"y":2,"text":"value","enter":null}),
        json!({"kind":"text","x":1,"y":2,"text":"value","enter":1}),
    ] {
        reject(action, STRICT);
    }
}

#[test]
fn input_coordinates_speed_and_official_key_table_reject_invalid_boundaries() {
    for coordinate in [0, 32768] {
        reject(
            json!({"kind":"tap","x":coordinate,"y":1}),
            "输入无效：Harmony输入坐标须为1至32767整数",
        );
        reject(
            json!({"kind":"text","x":1,"y":coordinate,"text":"value"}),
            "输入无效：Harmony输入坐标须为1至32767整数",
        );
    }
    for speed in [0, 199, 40001] {
        reject(
            json!({"kind":"swipe","x1":1,"y1":2,"x2":3,"y2":4,"velocity_pps":speed}),
            "输入无效：Harmony滑动须有位移，速度须为200至40000像素每秒",
        );
    }
    reject(
        json!({"kind":"swipe","x1":1,"y1":2,"x2":1,"y2":2}),
        "输入无效：Harmony滑动须有位移，速度须为200至40000像素每秒",
    );
    for key in [0, 3, 20, 21, 24, 66, 1999, 2123, 2633, 2835, 2840, 65535] {
        reject(
            json!({"kind":"keyevent","key_code":key}),
            "输入无效：Harmony按键码不在固定官方档案的可用表中",
        );
    }
}

#[test]
fn input_text_empty_controls_and_utf8_byte_overflow_reject_without_tools() {
    for text in [
        "".to_owned(),
        "\n".to_owned(),
        "\r".to_owned(),
        "\t".to_owned(),
        "\0".to_owned(),
        "\u{7f}".to_owned(),
        "\u{85}".to_owned(),
        "界".repeat(342),
        "x".repeat(1025),
    ] {
        reject(
            json!({"kind":"text","x":1,"y":2,"text":text}),
            "输入无效：Harmony文本须为1至1024个UTF-8字节且不含控制符",
        );
    }
}

#[test]
fn input_artifacts_and_device_injection_reject_before_any_hdc() {
    for serial in ["-target", "device;id", "device id", "device\n", "设备"] {
        let input = Input::new("input-device-injection", tap());
        let mut request = input.request;
        request["input"]["device_id"] = json!(serial);
        input
            .fixture
            .reject(request, "输入无效：设备标识包含不支持的字符或超过200字节");
    }
    let input = Input::new("input-artifact", tap());
    let mut request = input.request;
    request["artifacts"]["inputs"] = json!([{"field":"/input/action/text","artifact_id":"12345678-1234-1234-1234-123456789abc","filename":"input.txt","path":input.fixture.root.join("must-not-read"),"size":0,"sha256":"0".repeat(64)}]);
    input
        .fixture
        .reject(request, "输入无效：该设备动作不接受输入产物");
}

#[test]
fn input_start_gate_zero_budget_and_delayed_start_have_zero_tool_effects() {
    let input = Input::new("input-start-gate", tap());
    input.normal("uitest uiInput click 1 32767", false);
    let mut running = input.fixture.begin_request(input.request.clone());
    thread::sleep(Duration::from_millis(80));
    input.fixture.assert_calls(0);
    running.start(Duration::from_secs(20));
    let probes: Vec<_> = (1..=3).map(|ordinal| input.release(ordinal)).collect();
    success(&running.complete());
    for probe in probes {
        probe.assert_exited();
    }
    for remaining in [Duration::ZERO, Duration::from_millis(20)] {
        let input = Input::new("input-start-budget", tap());
        let mut running = input.fixture.begin_request(input.request.clone());
        thread::sleep(Duration::from_millis(50));
        running.start(remaining);
        failure(&running.complete(), TOTAL_TIMEOUT);
        input.fixture.assert_calls(0);
    }
}

#[test]
fn input_version_mismatch_and_help_mismatch_stop_before_action_with_complete_cleanup() {
    for output in [
        b"5.0.1.2\nDF_INPUT_DONE:{{TOKEN}}:version:0\n".as_slice(),
        b"HarmonyOS 5.0.1.1\nDF_INPUT_DONE:{{TOKEN}}:version:0\n".as_slice(),
    ] {
        let input = Input::new("input-wrong-version", tap());
        input.qualify();
        input.replace(1, output, b"", 0);
        failure(
            &input.run(1),
            "工具依赖失败：设备uitest版本不在当前固定输入档案中",
        );
    }
    for output in [
        replace_first(HELP, b"default 600", b"default 500"),
        replace_first(HELP, b"inputText <x> <y> <text>", b"inputText <text>"),
        replace_first(
            HELP,
            b"keyEvent <keyID/Back/Home/Power> inject keyEvent\n",
            b"",
        ),
        replace_first(
            HELP,
            b"\nDF_INPUT_DONE:",
            b"\nkeyEvent <keyID/Back/Home/Power> inject keyEvent\nDF_INPUT_DONE:",
        ),
    ] {
        let input = Input::new("input-wrong-help", tap());
        input.qualify();
        input.replace(2, &output, b"", 0);
        failure(
            &input.run(2),
            "工具依赖失败：设备uitest帮助不符合当前固定输入档案",
        );
    }
}

fn replace_first(bytes: &[u8], old: &[u8], new: &[u8]) -> Vec<u8> {
    let offset = bytes
        .windows(old.len())
        .position(|part| part == old)
        .unwrap();
    [&bytes[..offset], new, &bytes[offset + old.len()..]].concat()
}

#[test]
fn input_confirmed_remote_failure_diagnostic_and_nonempty_client_stderr_are_business_failures() {
    for (stdout, stderr, error) in [
        (
            b"No Error\nDF_INPUT_DONE:{{TOKEN}}:action:7\n".as_slice(),
            b"".as_slice(),
            "工具依赖失败：Harmony输入远端命令执行失败",
        ),
        (
            b"No Error trailing\nDF_INPUT_DONE:{{TOKEN}}:action:0\n".as_slice(),
            b"".as_slice(),
            "工具依赖失败：Harmony输入未返回固定档案的明确成功诊断",
        ),
        (
            b"Permission denied\nDF_INPUT_DONE:{{TOKEN}}:action:0\n".as_slice(),
            b"".as_slice(),
            "工具依赖失败：Harmony输入未返回固定档案的明确成功诊断",
        ),
        (
            ACTION,
            b"client warning".as_slice(),
            "工具依赖失败：HDC输入客户端返回非空诊断",
        ),
    ] {
        let input = Input::new("input-confirmed-failure", tap());
        input.normal("uitest uiInput click 1 32767", false);
        input.replace(3, stdout, stderr, 0);
        failure(&input.run(3), error);
    }
    let input = Input::new("input-whitespace-stderr", tap());
    input.normal("uitest uiInput click 1 32767", false);
    input.replace(3, ACTION, b" \r\n\t", 0);
    success(&input.run(3));
}

#[test]
fn input_client_nonzero_with_full_remote_receipt_keeps_completion_evidence() {
    let input = Input::new("input-client-nonzero", tap());
    input.normal("uitest uiInput click 1 32767", false);
    input.replace(3, ACTION, b"", 7);
    failure(
        &input.run(3),
        "工具依赖失败：HDC客户端执行失败，请检查部署配置",
    );
}

#[test]
fn input_missing_forged_duplicate_nonterminal_and_noncanonical_receipts_remain_unknown() {
    for output in [
        b"No Error\n".as_slice(),
        b"No Error\nDF_INPUT_DONE:{{TOKEN}}:action:0".as_slice(),
        b"No Error\nDF_INPUT_DONE:00000000000000000000000000000000:action:0\n".as_slice(),
        b"No Error\nDF_INPUT_DONE:{{TOKEN}}:enter:0\n".as_slice(),
        b"No Error\nDF_INPUT_DONE:{{TOKEN}}:action:0\nDF_INPUT_DONE:{{TOKEN}}:action:0\n"
            .as_slice(),
        b"No Error\nDF_INPUT_DONE:{{TOKEN}}:action:0\nafter\n".as_slice(),
        b"No Error\nDF_INPUT_DONE:{{TOKEN}}:action:00\n".as_slice(),
        b"No Error\nDF_INPUT_DONE:{{TOKEN}}:action:+0\n".as_slice(),
        b"No Error\nDF_INPUT_DONE:{{TOKEN}}:action:256\n".as_slice(),
        b"No Error\nDF_INPUT_DONE:{{TOKEN}}:action:\n".as_slice(),
        b"No Error\rDF_INPUT_DONE:{{TOKEN}}:action:0\n".as_slice(),
        b"\xff\nDF_INPUT_DONE:{{TOKEN}}:action:0\n".as_slice(),
    ] {
        let input = Input::new("input-invalid-receipt", tap());
        input.normal("uitest uiInput click 1 32767", false);
        input.replace(3, output, b"", 0);
        unknown(&input.run(3));
    }
}

#[test]
fn input_missing_receipt_at_every_phase_never_dispatches_later_events() {
    for stage in 1..=4 {
        let input = Input::new(
            "input-phase-receipt",
            json!({"kind":"text","x":1,"y":2,"text":"value","enter":true}),
        );
        input.normal("uitest uiInput inputText 1 2 'value'", true);
        input.replace(stage, b"No Error\n", b"", 0);
        unknown(&input.run(stage));
    }
}

#[test]
fn input_official_key_table_accepts_distant_positive_boundaries() {
    for key in [
        1, 2, 19, 22, 41, 2000, 2122, 2210, 2632, 2634, 2731, 2834, 2836, 2847, 3001, 3109,
    ] {
        let input = Input::new(
            "input-official-key-boundary",
            json!({"kind":"keyevent","key_code":key}),
        );
        input.normal(&format!("uitest uiInput keyEvent {key}"), false);
        assert_eq!(success(&input.run(3))["action"], "keyevent");
    }
}

#[test]
fn input_raw_stdout_and_stderr_hard_limits_never_infer_remote_completion() {
    for stdout_overflow in [true, false] {
        let input = Input::new("input-output-limit", tap());
        input.normal("uitest uiInput click 1 32767", false);
        let bytes = vec![b'x'; 1024 * 1024 + 1];
        if stdout_overflow {
            input.replace(3, &bytes, b"", 0);
        } else {
            input.replace(3, ACTION, &bytes, 0);
        }
        unknown(&input.run(3));
    }
}

fn interrupt(stage: usize, mode: &str) {
    let input = Input::new(
        "input-running-interruption",
        json!({"kind":"text","x":1,"y":2,"text":"value","enter":true}),
    );
    input.normal("uitest uiInput inputText 1 2 'value'", true);
    let remaining = if mode == "deadline" {
        Duration::from_secs(2)
    } else {
        Duration::from_secs(20)
    };
    let spawning = Instant::now();
    let mut running = input.fixture.begin_request(input.request.clone());
    // Ready前进程创建不属于发送Start后的执行耗时，原期限及其余断言保持不变。
    let start = Instant::now();
    let ready_wait = start.duration_since(spawning);
    running.start(remaining);
    let mut probes = Vec::new();
    for ordinal in 1..stage {
        if mode == "deadline" {
            let probe = input.fixture.wait_tool_at(ordinal);
            thread::sleep(Duration::from_millis(350));
            input.fixture.release_call(ordinal);
            probes.push(probe);
        } else {
            probes.push(input.release(ordinal));
        }
    }
    let probe = input.fixture.wait_tool_at(stage);
    assert!(
        !input
            .fixture
            .root
            .join(format!("plan-{stage:02}/release"))
            .exists()
    );
    match mode {
        "cancel" => running.cancel("cancelled"),
        "eof" => running.eof(),
        _ => {}
    }
    failed(
        &running.complete(),
        if mode == "deadline" {
            TOTAL_TIMEOUT
        } else {
            CANCELLED
        },
    );
    probes.push(probe);
    for probe in probes {
        probe.assert_exited();
    }
    input.fixture.assert_calls(stage);
    assert!(
        !input
            .fixture
            .root
            .join(format!("plan-{stage:02}/release"))
            .exists()
    );
    assert!(!input.fixture.root.join("unused-output").exists());
    let elapsed = start.elapsed();
    fs::write(
        input.fixture.root.join("interruption-timing.json"),
        serde_json::to_vec(&json!({
            "mode":mode,"stage":stage,"ready_wait_ns":ready_wait.as_nanos(),
            "start_to_completion_ns":elapsed.as_nanos(),"budget_ns":remaining.as_nanos()
        }))
        .unwrap(),
    )
    .unwrap();
    assert!(
        elapsed < Duration::from_secs(5),
        "原期限和既有清理点不得重授"
    );
    if mode == "deadline" {
        assert!(
            elapsed < Duration::from_millis(2750),
            "前面阶段消耗的预算不得在后续阶段重授"
        );
    }
}

#[test]
fn input_cancel_every_phase_keeps_remote_unknown_and_never_sends_later_enter() {
    for stage in 1..=4 {
        interrupt(stage, "cancel");
    }
}

#[test]
fn input_eof_every_phase_keeps_remote_unknown_and_confirms_direct_client_exit() {
    for stage in 1..=4 {
        interrupt(stage, "eof");
    }
}

#[test]
fn input_each_phase_consumes_original_deadline_without_new_cleanup_budget() {
    for stage in 1..=4 {
        interrupt(stage, "deadline");
    }
}

pub(super) fn discovered(id: &str, available: bool, reason: Option<&str>) -> Value {
    let mut device = expected_device(id);
    let mut capability = json!({"id":"input","version":1,"available":available});
    if let Some(reason) = reason {
        capability["reason"] = json!(reason);
    }
    device["capabilities"]
        .as_array_mut()
        .unwrap()
        .push(capability);
    device
}

pub(super) fn qualified_discovery(bytes: &[u8], ids: &[&str]) -> Value {
    let input = Input::new("input-qualified-discovery", tap());
    input.fixture.plan_call(1, bytes, b"", 0);
    for (index, id) in ids.iter().enumerate() {
        input.plan(
            2 + index * 2,
            "version",
            "uitest --version",
            (VERSION, b"", 0),
            id,
        );
        input.plan(3 + index * 2, "help", "uitest help", (HELP, b"", 0), id);
    }
    let mut running = input.fixture.begin("discover", json!({}));
    running.start(Duration::from_secs(20));
    let list = input.fixture.wait_tool_at(1);
    assert_eq!(input.fixture.argv_at(1), ["list", "targets"]);
    input.fixture.release_call(1);
    let mut probes = vec![list];
    probes.extend((2..=1 + ids.len() * 2).map(|ordinal| input.release(ordinal)));
    let reply = running.complete();
    for probe in probes {
        probe.assert_exited();
    }
    input.fixture.assert_calls(1 + ids.len() * 2);
    reply
}

pub(super) fn unfinished_discovery(bytes: &[u8], first: &str) -> Value {
    let input = Input::new("input-discovery-window", tap());
    input.fixture.plan_call(1, bytes, b"", 0);
    input.plan(2, "version", "uitest --version", (VERSION, b"", 0), first);
    let mut running = input.fixture.begin("discover", json!({}));
    running.start(Duration::from_secs(20));
    let list = input.fixture.wait_tool_at(1);
    input.fixture.release_call(1);
    let version = input.fixture.wait_tool_at(2);
    thread::sleep(Duration::from_millis(8250));
    version.assert_running();
    input.fixture.assert_calls(2);
    input.fixture.release_call(2);
    let reply = running.complete();
    list.assert_exited();
    version.assert_exited();
    input.fixture.assert_calls(2);
    assert!(!input.fixture.root.join("call-03").exists());
    reply
}

#[test]
fn input_discovery_online_status_requires_fresh_exact_qualification() {
    assert_eq!(
        success(&qualified_discovery(
            b"HDC001\nHDC002\n",
            &["HDC001", "HDC002"]
        )),
        &json!([
            discovered("HDC001", true, None),
            discovered("HDC002", true, None)
        ])
    );
    for (stdout, stage, calls) in [
        (
            b"5.0.1.2\nDF_INPUT_DONE:{{TOKEN}}:version:0\n".as_slice(),
            2,
            2,
        ),
        (
            b"help unsupported\nDF_INPUT_DONE:{{TOKEN}}:help:0\n".as_slice(),
            3,
            3,
        ),
    ] {
        let input = Input::new("input-discovery-ineligible", tap());
        input.fixture.plan_call(1, b"HDC001\n", b"", 0);
        input.plan(
            2,
            "version",
            "uitest --version",
            (VERSION, b"", 0),
            "HDC001",
        );
        input.plan(3, "help", "uitest help", (HELP, b"", 0), "HDC001");
        input.replace(stage, stdout, b"", 0);
        let mut running = input.fixture.begin("discover", json!({}));
        running.start(Duration::from_secs(20));
        let list = input.fixture.wait_tool_at(1);
        input.fixture.release_call(1);
        let probes: Vec<_> = (2..=calls).map(|ordinal| input.release(ordinal)).collect();
        let reply = running.complete();
        list.assert_exited();
        for probe in probes {
            probe.assert_exited();
        }
        assert_eq!(
            success(&reply),
            &json!([discovered(
                "HDC001",
                false,
                Some("设备uitest未通过当前固定输入档案资格探测")
            )])
        );
        input.fixture.assert_calls(calls);
    }
}

#[test]
fn input_discovery_missing_remote_receipt_is_sticky_and_never_returns_optimistic_directory() {
    let input = Input::new("input-discovery-unknown", tap());
    input.fixture.plan_call(1, b"HDC001\nHDC002\n", b"", 0);
    input.plan(
        2,
        "version",
        "uitest --version",
        (b"5.0.1.1\n", b"", 0),
        "HDC001",
    );
    let mut running = input.fixture.begin("discover", json!({}));
    running.start(Duration::from_secs(20));
    let list = input.fixture.wait_tool_at(1);
    input.fixture.release_call(1);
    let version = input.release(2);
    unknown(&running.complete());
    list.assert_exited();
    version.assert_exited();
    input.fixture.assert_calls(2);
}
