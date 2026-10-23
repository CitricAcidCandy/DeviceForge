use crate::support::{
    CANCELLED, Fixture, Invocation, PidProbe, SERIAL, TOTAL_TIMEOUT, artifacts, device,
};
use serde_json::{Value, json};
use std::{
    cell::Cell,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

const IMAGE_LIMIT: usize = 64 * 1024 * 1024;
const ENCODED_LIMIT: usize = 89_478_488;
const FRAME_LIMIT: usize = 89_478_616;
const PROBE: &[u8] = b"RGV2aWNlRm9yZ2U=\nDF_PROBE_DONE:{{TOKEN}}:0\n";
const CAPTURE: &[u8] = b"DF_OWNER_READY:{{TOKEN}}\n\nsuccess: snapshot display 0 , write to {{REMOTE}}/screenshot.jpeg as jpeg, width 1, height 1\n\nDF_CAPTURED:{{TOKEN}}:0\n";
const SIZE: &[u8] = b"\nDF_IMAGE_SIZE:{{TOKEN}}:0:{{SIZE}}\n";
const READ: &[u8] = b"\nDF_READ_DONE:{{TOKEN}}:0\n";
const CLEAR: &[u8] = b"DF_CLEARED:{{TOKEN}}\n";

fn jpeg() -> Vec<u8> {
    vec![
        0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
        0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x01, 0xff, 0x00, 0x02, 0xff,
        0xd9,
    ]
}

struct Screenshot {
    fixture: Fixture,
    scratch: PathBuf,
    output: PathBuf,
    request: Value,
    invocation_deadline: Cell<Option<Instant>>,
}

impl Screenshot {
    fn new(label: &str, image: &[u8]) -> Self {
        let mut fixture = Fixture::new(label);
        let scratch = artifacts::configure_scratch(&mut fixture);
        let output = fixture.root.join("authorized-output");
        fs::create_dir(&output).unwrap();
        fs::write(fixture.root.join("screenshot-fixture"), b"1").unwrap();
        fs::write(fixture.root.join("screenshot-source.jpeg"), image).unwrap();
        let mut request = fixture.request("screenshot", device(json!({})));
        request["artifacts"]["output_directory"] = json!(output);
        Self {
            fixture,
            scratch,
            output,
            request,
            invocation_deadline: Cell::new(None),
        }
    }
    fn plan(&self, ordinal: usize, stdout: &[u8], stderr: &[u8], code: i32, action: &str) {
        self.fixture.plan_call(ordinal, stdout, stderr, code);
        self.set(ordinal, "screenshot-action", action.as_bytes());
    }
    fn set(&self, ordinal: usize, name: &str, bytes: &[u8]) {
        fs::write(
            self.fixture
                .root
                .join(format!("plan-{ordinal:02}"))
                .join(name),
            bytes,
        )
        .unwrap();
    }
    fn overwrite(&self, ordinal: usize, stdout: &[u8], stderr: &[u8], code: i32) {
        self.set(ordinal, "stdout", stdout);
        self.set(ordinal, "stderr", stderr);
        self.set(ordinal, "code", code.to_string().as_bytes());
    }
    fn clear_at(&self, ordinal: usize) {
        self.overwrite(ordinal, CLEAR, b"", 0);
        self.set(ordinal, "screenshot-action", b"clear");
        let base64 = self
            .fixture
            .root
            .join(format!("plan-{ordinal:02}/screenshot-base64"));
        if base64.exists() {
            fs::remove_file(base64).unwrap();
        }
    }
    fn body(&self, bytes: &[u8]) {
        fs::remove_file(self.fixture.root.join("plan-04/screenshot-base64")).unwrap();
        self.set(4, "screenshot-body.bin", bytes);
    }
    fn begin(&self, remaining: Duration) -> Invocation {
        let mut running = self.fixture.begin_request(self.request.clone());
        self.invocation_deadline
            .set(Some(Instant::now() + remaining));
        running.start(remaining);
        running
    }
    fn normal_plan(&self) {
        self.plan(1, PROBE, b"", 0, "none");
        self.plan(2, CAPTURE, b"", 0, "capture");
        self.plan(3, SIZE, b"", 0, "none");
        self.plan(4, READ, b"", 0, "none");
        self.set(4, "screenshot-base64", b"1");
        self.plan(5, CLEAR, b"", 0, "clear");
    }
    fn advance_to(&self, last: usize) {
        for (offset, stage) in ["probe", "capture", "size", "read", "clear"]
            .into_iter()
            .take(last)
            .enumerate()
        {
            self.advance(offset + 1, stage);
        }
    }
    fn token(&self, ordinal: usize) -> String {
        let token = fs::read_to_string(
            self.fixture
                .root
                .join(format!("call-{ordinal:02}/screenshot.token")),
        )
        .unwrap();
        assert_eq!(token.len(), 32);
        assert!(
            token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
        if ordinal > 1 {
            assert_eq!(token, self.token(1));
        }
        token
    }
    fn remote(&self) -> PathBuf {
        self.fixture
            .root
            .join("screenshot-remote")
            .join(format!("deviceforge-screenshot-{}", self.token(1)))
    }
    fn hold(&self, ordinal: usize, stage: &str) -> PidProbe {
        let probe = self.fixture.wait_tool_at_with_deadline(
            ordinal,
            self.invocation_deadline
                .get()
                .expect("截图调用必须先发送Start"),
        );
        assert_eq!(
            fs::read_to_string(
                self.fixture
                    .root
                    .join(format!("call-{ordinal:02}/screenshot.stage")),
            )
            .unwrap(),
            stage
        );
        assert_eq!(
            self.fixture.argv_at(ordinal),
            expected_argv(stage, &self.token(ordinal))
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
        probe
    }
    fn advance(&self, ordinal: usize, stage: &str) {
        let probe = self.hold(ordinal, stage);
        self.fixture.release_call(ordinal);
        probe.assert_exited();
    }
    fn assert_no_output(&self) {
        artifacts::empty(&self.output);
        artifacts::empty(&self.scratch);
    }
    fn assert_no_remote(&self) {
        if self.fixture.root.join("call-01/ready").exists() {
            assert!(!self.remote().exists());
        }
    }
    fn worker(&self, ordinal: usize) -> PidProbe {
        let call = self.fixture.root.join(format!("call-{ordinal:02}"));
        assert_eq!(fs::read(call.join("late-worker.ready")).unwrap(), b"1");
        let pid = fs::read_to_string(call.join("late-worker.pid"))
            .unwrap()
            .parse()
            .unwrap();
        let probe = PidProbe::open(pid, call.join("late-worker-test-fallback-kill"));
        probe.assert_running();
        #[cfg(windows)]
        {
            let read = |name| -> Value {
                serde_json::from_slice(&fs::read(call.join(name)).unwrap()).unwrap()
            };
            let before = read("hdc-stdio-before.json");
            let after = read("hdc-stdio-after.json");
            let worker = read("late-worker-stdio.json");
            assert_eq!(worker["pid"], pid);
            assert_eq!(before["pid"], after["pid"]);
            assert_eq!(before["handles"].as_array().unwrap().len(), 3);
            assert_eq!(after["handles"].as_array().unwrap().len(), 3);
            assert_eq!(worker["handles"].as_array().unwrap().len(), 3);
            for index in 0..3 {
                assert_eq!(
                    before["handles"][index]["handle"],
                    after["handles"][index]["handle"]
                );
                assert_eq!(before["handles"][index]["file_type"], 3);
                assert_eq!(after["handles"][index]["file_type"], 3);
                assert_eq!(
                    before["handles"][index]["flags"].as_u64().unwrap() & !1,
                    after["handles"][index]["flags"].as_u64().unwrap()
                );
                assert_eq!(worker["handles"][index]["file_type"], 2);
            }
            assert!(!call.join("late-worker-stdio.error.json").exists());
        }
        probe
    }
    fn release_worker(&self, ordinal: usize) {
        let call = self.fixture.root.join(format!("call-{ordinal:02}"));
        fs::write(call.join("late-worker.trigger.tmp"), b"1").unwrap();
        fs::rename(
            call.join("late-worker.trigger.tmp"),
            call.join("late-worker.trigger"),
        )
        .unwrap();
    }
}

fn assert_failure(reply: &Value, expected: &str, cleanup: &str) {
    assert_eq!(reply["cleanup"], cleanup);
    assert_eq!(reply["response"]["error"], expected);
    assert!(reply["response"].get("result").is_none());
    assert!(reply["response"].get("outputs").is_none());
}

fn assert_success(case: &Screenshot, reply: &Value, bytes: &[u8]) {
    assert_success_contract(case, reply);
    assert_eq!(
        fs::read(case.output.join("screenshot.jpeg")).unwrap(),
        bytes
    );
}

fn assert_success_contract(case: &Screenshot, reply: &Value) {
    assert_eq!(reply["cleanup"], "complete");
    assert!(reply["response"].get("error").is_none());
    assert_eq!(reply["response"]["result"], Value::Null);
    assert_eq!(
        reply["response"]["outputs"],
        json!([{"filename":"screenshot.jpeg"}])
    );
    assert_eq!(fs::read_dir(&case.output).unwrap().count(), 1);
    artifacts::empty(&case.scratch);
    case.assert_no_remote();
    case.fixture.assert_calls(5);
}

fn expected_argv(stage: &str, token: &str) -> Vec<String> {
    let remote = format!("/data/local/tmp/deviceforge-screenshot-{token}");
    let script = match stage {
        "probe" => format!(
            "printf 'DeviceForge' | base64 -w 0\nprobe_status=$?\nprintf '\\nDF_PROBE_DONE:{token}:%s\\n' \"$probe_status\"\n"
        ),
        "capture" => format!(
            "umask 077\nif ! mkdir '{remote}'; then\n  printf '\\nDF_DIR_REJECTED:{token}\\n'\n  exit 1\nfi\nif ! printf '{token}\\n' > '{remote}/owner'; then\n  printf '\\nDF_OWNER_FAILED:{token}\\n'\n  exit 1\nfi\nprintf 'DF_OWNER_READY:{token}\\n'\nsnapshot_display -f '{remote}/screenshot.jpeg'\ncapture_status=$?\nprintf '\\nDF_CAPTURED:{token}:%s\\n' \"$capture_status\"\n"
        ),
        "size" => format!(
            "if [ \"$(cat '{remote}/owner')\" != '{token}' ]; then\n  printf '\\nDF_SIZE_REJECTED:{token}\\n'\n  exit 1\nfi\nif [ ! -f '{remote}/screenshot.jpeg' ] || [ -L '{remote}/screenshot.jpeg' ]; then\n  printf '\\nDF_SIZE_REJECTED:{token}\\n'\n  exit 1\nfi\nimage_size=$(wc -c < '{remote}/screenshot.jpeg')\nsize_status=$?\nprintf '\\nDF_IMAGE_SIZE:{token}:%s:%s\\n' \"$size_status\" \"$image_size\"\n"
        ),
        "read" => format!(
            "if [ \"$(cat '{remote}/owner')\" != '{token}' ]; then\n  printf '\\nDF_READ_REJECTED:{token}\\n'\n  exit 1\nfi\nbase64 -w 0 '{remote}/screenshot.jpeg'\nread_status=$?\nprintf '\\nDF_READ_DONE:{token}:%s\\n' \"$read_status\"\n"
        ),
        "clear" => format!(
            "if [ \"$(cat '{remote}/owner')\" != '{token}' ]; then\n  printf '\\nDF_CLEAR_REJECTED:{token}\\n'\n  exit 1\nfi\nif ! rm -f '{remote}/screenshot.jpeg'; then\n  printf '\\nDF_CLEAR_REJECTED:{token}\\n'\n  exit 1\nfi\nif ! rm '{remote}/owner' || ! rmdir '{remote}'; then\n  printf '\\nDF_CLEAR_REJECTED:{token}\\n'\n  exit 1\nfi\nif [ -e '{remote}' ] || [ -L '{remote}' ]; then\n  printf '\\nDF_CLEAR_REJECTED:{token}\\n'\n  exit 1\nfi\nprintf 'DF_CLEARED:{token}\\n'\n"
        ),
        _ => panic!("独立期望只接受五个截图阶段"),
    };
    vec![
        "-t".to_owned(),
        SERIAL.to_owned(),
        "shell".to_owned(),
        script,
    ]
}

#[test]
fn screenshot_strict_envelope_rejects_before_configuration_or_tools() {
    for input in [
        json!({"input":{}}),
        json!({"device_id":SERIAL}),
        json!({"device_id":SERIAL,"input":{"path":"/data/local/tmp/other"}}),
        json!({"device_id":SERIAL,"input":{},"extra":true}),
        json!({"device_id":null,"input":{}}),
        json!({"device_id":SERIAL,"input":null}),
    ] {
        let mut case = Screenshot::new("screenshot-strict", &jpeg());
        let missing = input.get("device_id").is_none() || input.get("input").is_none();
        case.request["input"] = input;
        let business_is_object = case.request["input"]["input"].is_object();
        fs::write(&case.fixture.config_path, b"invalid-json-before-validation").unwrap();
        let reply = case.begin(Duration::from_secs(20)).complete();
        assert_failure(
            &reply,
            if missing {
                "输入无效：设备动作封套必须显式提供device_id和input"
            } else if !business_is_object {
                "输入无效：设备动作及业务输入必须为对象"
            } else {
                "输入无效：设备动作封套或业务字段不符合严格格式"
            },
            "complete",
        );
        case.fixture.assert_calls(0);
        case.assert_no_output();
    }
}

#[test]
fn screenshot_rejects_input_artifacts_before_configuration_or_source_read() {
    let mut case = Screenshot::new("screenshot-input-artifact", &jpeg());
    let source = artifacts::installation(&case.fixture, b"never consumed");
    case.request["artifacts"]["inputs"] = source["artifacts"]["inputs"].clone();
    fs::write(&case.fixture.config_path, b"invalid-before-input-copy").unwrap();
    let reply = case.begin(Duration::from_secs(20)).complete();
    assert_failure(&reply, "输入无效：该设备动作不接受输入产物", "complete");
    case.fixture.assert_calls(0);
    case.assert_no_output();
}

#[test]
fn screenshot_pre_cancel_and_zero_budget_start_do_not_dispatch_hdc() {
    for cancel in [false, true] {
        let case = Screenshot::new("screenshot-pre-control", &jpeg());
        let mut running = case.fixture.begin_request(case.request.clone());
        fs::write(&case.fixture.config_path, b"invalid-before-start").unwrap();
        if cancel {
            running.send_batch(&[
                running.start_frame(Duration::from_secs(20)),
                running.cancel_frame("cancelled"),
            ]);
        } else {
            running.start(Duration::ZERO);
        }
        assert_failure(
            &running.complete(),
            if cancel { CANCELLED } else { TOTAL_TIMEOUT },
            "complete",
        );
        case.fixture.assert_calls(0);
        case.assert_no_output();
    }
}

#[test]
fn screenshot_delayed_start_spends_original_budget_without_creating_files() {
    let case = Screenshot::new("screenshot-delayed-start", &jpeg());
    let mut running = case.fixture.begin_request(case.request.clone());
    thread::sleep(Duration::from_millis(500));
    running.start(Duration::from_millis(200));
    assert_failure(&running.complete(), TOTAL_TIMEOUT, "complete");
    case.fixture.assert_calls(0);
    case.assert_no_output();
}

#[test]
fn screenshot_five_fixed_commands_publish_exact_jpeg_and_confirm_all_resources() {
    let bytes = jpeg();
    let case = Screenshot::new("screenshot-normal", &bytes);
    case.normal_plan();
    let running = case.begin(Duration::from_secs(20));
    case.advance_to(5);
    assert_success(&case, &running.complete(), &bytes);
    let counts: Value = serde_json::from_slice(
        &fs::read(case.fixture.root.join("call-04/base64-counts.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(counts, json!({"raw":31,"encoded":44}));
}

#[test]
fn screenshot_crlf_capture_and_single_body_line_ending_preserve_original_bytes() {
    for ending in ["\n", "\r\n"] {
        let bytes = jpeg();
        let case = Screenshot::new("screenshot-line-ending", &bytes);
        case.normal_plan();
        let capture = String::from_utf8(CAPTURE.to_vec())
            .unwrap()
            .replace('\n', "\r\n");
        case.overwrite(2, capture.as_bytes(), b"", 0);
        let tail = format!("{ending}\r\nDF_READ_DONE:{{{{TOKEN}}}}:0\r\n");
        case.overwrite(4, tail.as_bytes(), b"", 0);
        let running = case.begin(Duration::from_secs(20));
        case.advance_to(5);
        assert_success(&case, &running.complete(), &bytes);
    }
}

#[test]
fn screenshot_missing_or_foreign_receipts_never_infer_remote_completion() {
    for (ordinal, stage, stdout) in [
        (1, "probe", b"RGV2aWNlRm9yZ2U=".as_slice()),
        (
            1,
            "probe",
            b"RGV2aWNlRm9yZ2U=\nDF_PROBE_DONE:00000000000000000000000000000000:0\n".as_slice(),
        ),
        (
            1,
            "probe",
            b"RGV2aWNlRm9yZ2U=\nDF_PROBE_DONE:{{TOKEN}}:0\nDF_PROBE_DONE:{{TOKEN}}:0\n".as_slice(),
        ),
        (
            1,
            "probe",
            b"RGV2aWNlRm9yZ2U=\nDF_PROBE_DONE:{{TOKEN}}:0".as_slice(),
        ),
        (2, "capture", b"DF_OWNER_READY:{{TOKEN}}\n".as_slice()),
        (
            2,
            "capture",
            b"DF_OWNER_READY:{{TOKEN}}\nDF_CAPTURED:00000000000000000000000000000000:0\n"
                .as_slice(),
        ),
        (
            2,
            "capture",
            b"DF_OWNER_READY:{{TOKEN}}\nDF_CAPTURED:{{TOKEN}}:0\nDF_CAPTURED:{{TOKEN}}:0\n"
                .as_slice(),
        ),
        (3, "size", b"31\n".as_slice()),
        (
            3,
            "size",
            b"DF_IMAGE_SIZE:00000000000000000000000000000000:0:31\n".as_slice(),
        ),
        (
            3,
            "size",
            b"DF_IMAGE_SIZE:{{TOKEN}}:0:31\nDF_IMAGE_SIZE:{{TOKEN}}:0:31\n".as_slice(),
        ),
        (4, "read", b"\n".as_slice()),
        (
            4,
            "read",
            b"\nDF_READ_DONE:00000000000000000000000000000000:0\n".as_slice(),
        ),
        (
            4,
            "read",
            b"\nDF_READ_DONE:{{TOKEN}}:0\nDF_READ_DONE:{{TOKEN}}:0\n".as_slice(),
        ),
        (
            4,
            "read",
            b"\nDF_READ_DONE:{{TOKEN}}:0\ntrailing".as_slice(),
        ),
        (5, "clear", b"".as_slice()),
        (
            5,
            "clear",
            b"DF_CLEARED:00000000000000000000000000000000\n".as_slice(),
        ),
        (
            5,
            "clear",
            b"DF_CLEARED:{{TOKEN}}\nDF_CLEARED:{{TOKEN}}\n".as_slice(),
        ),
    ] {
        let case = Screenshot::new("screenshot-unconfirmed", &jpeg());
        case.normal_plan();
        case.overwrite(ordinal, stdout, b"", 0);
        let running = case.begin(Duration::from_secs(20));
        case.advance_to(ordinal - 1);
        case.advance(ordinal, stage);
        let reply = running.complete();
        assert_failure(&reply, "插件资源清理未确认", "failed");
        case.fixture.assert_calls(ordinal);
        case.assert_no_output();
        if (2..5).contains(&ordinal) {
            assert!(case.remote().join("owner").is_file());
            assert!(case.remote().join("screenshot.jpeg").is_file());
        } else {
            case.assert_no_remote();
        }
    }
}

#[test]
fn screenshot_owner_creation_failure_retains_unconfirmed_directory_without_owner() {
    let case = Screenshot::new("screenshot-owner-failed", &jpeg());
    case.normal_plan();
    case.overwrite(2, b"\nDF_OWNER_FAILED:{{TOKEN}}\n", b"", 0);
    case.set(2, "screenshot-action", b"directory-without-owner");
    let running = case.begin(Duration::from_secs(20));
    case.advance_to(2);
    assert_failure(&running.complete(), "插件资源清理未确认", "failed");
    assert!(case.remote().is_dir());
    assert!(!case.remote().join("owner").exists());
    assert!(!case.remote().join("screenshot.jpeg").exists());
    case.fixture.assert_calls(2);
    case.assert_no_output();
}

#[test]
fn screenshot_invalid_utf8_terminal_cannot_confirm_remote_stage_exit() {
    for (offset, stage) in ["probe", "capture", "size", "clear"]
        .into_iter()
        .enumerate()
    {
        let ordinal = if stage == "clear" { 5 } else { offset + 1 };
        let case = Screenshot::new("screenshot-terminal-utf8", &jpeg());
        case.normal_plan();
        let valid = [PROBE, CAPTURE, SIZE, CLEAR][offset];
        let stdout = [b"\xff".as_slice(), valid].concat();
        case.overwrite(ordinal, &stdout, b"", 0);
        let running = case.begin(Duration::from_secs(20));
        case.advance_to(ordinal - 1);
        case.advance(ordinal, stage);
        assert_failure(&running.complete(), "插件资源清理未确认", "failed");
        case.fixture.assert_calls(ordinal);
        case.assert_no_output();
    }
}

#[test]
fn screenshot_every_remote_stage_cancel_or_eof_keeps_unknown_remote_state_failed() {
    for (ordinal, stage) in ["probe", "capture", "size", "read", "clear"]
        .into_iter()
        .enumerate()
    {
        let ordinal = ordinal + 1;
        for mode in ["cancel", "eof"] {
            let case = Screenshot::new("screenshot-stage-control", &jpeg());
            case.normal_plan();
            let mut running = case.begin(Duration::from_secs(20));
            case.advance_to(ordinal - 1);
            let probe = case.hold(ordinal, stage);
            let start = Instant::now();
            if mode == "cancel" {
                running.cancel("cancelled");
            } else {
                running.eof();
            }
            assert_failure(&running.complete(), CANCELLED, "failed");
            assert!(start.elapsed() < Duration::from_millis(3500));
            probe.assert_exited();
            case.fixture.assert_calls(ordinal);
            assert!(
                !case
                    .fixture
                    .root
                    .join(format!("plan-{ordinal:02}/release"))
                    .exists()
            );
            case.assert_no_output();
        }
    }
}

#[test]
fn screenshot_every_remote_stage_uses_one_original_deadline() {
    for (offset, stage) in ["probe", "capture", "size", "read", "clear"]
        .into_iter()
        .enumerate()
    {
        let ordinal = offset + 1;
        let case = Screenshot::new("screenshot-stage-deadline", &jpeg());
        case.normal_plan();
        let running = case.begin(Duration::from_secs(3));
        case.advance_to(offset);
        let probe = case.hold(ordinal, stage);
        assert_failure(&running.complete(), TOTAL_TIMEOUT, "failed");
        probe.assert_exited();
        case.fixture.assert_calls(ordinal);
        case.assert_no_output();
    }
}

fn known_failure(ordinal: usize, stdout: &[u8], stderr: &[u8], expected: &str) {
    let case = Screenshot::new("screenshot-confirmed-failure", &jpeg());
    case.normal_plan();
    case.overwrite(ordinal, stdout, stderr, 0);
    if ordinal != 1 {
        case.clear_at(ordinal + 1);
    }
    let running = case.begin(Duration::from_secs(20));
    case.advance_to(ordinal - 1);
    let stage = ["probe", "capture", "size", "read"][ordinal - 1];
    case.advance(ordinal, stage);
    if ordinal != 1 {
        case.advance(ordinal + 1, "clear");
    }
    assert_failure(&running.complete(), expected, "complete");
    case.fixture
        .assert_calls(if ordinal == 1 { 1 } else { ordinal + 1 });
    case.assert_no_output();
    case.assert_no_remote();
}

#[test]
fn screenshot_completed_probe_rejects_wrong_encoding_nonzero_status_and_noise() {
    for stdout in [
        b"RGV2aWNlRm9yZ2V=\nDF_PROBE_DONE:{{TOKEN}}:0\n".as_slice(),
        b"RGV2aWNlRm9yZ2U=\nDF_PROBE_DONE:{{TOKEN}}:1\n".as_slice(),
        b"unexpected diagnostic\nRGV2aWNlRm9yZ2U=\nDF_PROBE_DONE:{{TOKEN}}:0\n".as_slice(),
    ] {
        known_failure(
            1,
            stdout,
            b"",
            "工具依赖失败：设备未通过base64 -w 0资格探测",
        );
    }
}

#[test]
fn screenshot_completed_capture_requires_official_path_owner_and_dimensions() {
    for (stdout, expected) in [
        (
            "DF_OWNER_READY:{{TOKEN}}\nDF_CAPTURED:{{TOKEN}}:1\n".to_owned(),
            "工具依赖失败：设备截图命令执行失败",
        ),
        (
            "DF_OWNER_READY:{{TOKEN}}\nDF_CAPTURED:{{TOKEN}}:0\n".to_owned(),
            "工具依赖失败：设备截图缺少唯一JPEG成功诊断",
        ),
        (
            String::from_utf8(CAPTURE.to_vec())
                .unwrap()
                .replace("/screenshot.jpeg", "/other.jpeg"),
            "工具依赖失败：设备截图成功路径不一致",
        ),
        (
            String::from_utf8(CAPTURE.to_vec())
                .unwrap()
                .replace("width 1", "width 0"),
            "工具依赖失败：设备截图尺寸诊断无效",
        ),
        (
            String::from_utf8(CAPTURE.to_vec())
                .unwrap()
                .replace("height 1", "height 65536"),
            "工具依赖失败：设备截图尺寸诊断无效",
        ),
        (
            String::from_utf8(CAPTURE.to_vec())
                .unwrap()
                .replace("display 0", "display -1"),
            "工具依赖失败：设备截图屏幕标识无效",
        ),
        (
            String::from_utf8(CAPTURE.to_vec()).unwrap().replace(
                "DF_OWNER_READY:{{TOKEN}}",
                "DF_OWNER_READY:00000000000000000000000000000000",
            ),
            "工具依赖失败：截图独占目录所有权未确认",
        ),
    ] {
        known_failure(2, stdout.as_bytes(), b"", expected);
    }
}

#[test]
fn screenshot_directory_collision_preserves_foreign_files_without_cleanup_command() {
    let case = Screenshot::new("screenshot-directory-collision", &jpeg());
    case.normal_plan();
    case.overwrite(2, b"\nDF_DIR_REJECTED:{{TOKEN}}\n", b"", 0);
    case.set(2, "screenshot-action", b"none");
    let running = case.begin(Duration::from_secs(20));
    case.advance(1, "probe");
    let probe = case.hold(2, "capture");
    fs::create_dir_all(case.remote()).unwrap();
    fs::write(case.remote().join("owner"), b"foreign-owner").unwrap();
    fs::write(case.remote().join("screenshot.jpeg"), b"foreign-image").unwrap();
    fs::write(case.remote().join("unexpected-file"), b"foreign-file").unwrap();
    case.fixture.release_call(2);
    probe.assert_exited();
    assert_failure(
        &running.complete(),
        "工具依赖失败：设备截图独占目录创建失败",
        "complete",
    );
    assert_eq!(
        fs::read(case.remote().join("owner")).unwrap(),
        b"foreign-owner"
    );
    assert_eq!(
        fs::read(case.remote().join("screenshot.jpeg")).unwrap(),
        b"foreign-image"
    );
    assert_eq!(
        fs::read(case.remote().join("unexpected-file")).unwrap(),
        b"foreign-file"
    );
    case.fixture.assert_calls(2);
    case.assert_no_output();
}

#[test]
fn screenshot_completed_size_checks_decimal_range_and_never_starts_reader_on_failure() {
    for (size, expected) in [
        ("0", "工具依赖失败：设备截图文件为空"),
        ("+31", "工具依赖失败：设备截图大小回执无效"),
        ("-31", "工具依赖失败：设备截图大小回执无效"),
        ("31x", "工具依赖失败：设备截图大小回执无效"),
        ("", "工具依赖失败：设备截图大小回执无效"),
        ("67108865", "数据超过插件限额"),
        ("18446744073709551616", "数据超过插件限额"),
    ] {
        let stdout = format!("\nDF_IMAGE_SIZE:{{{{TOKEN}}}}:0:{size}\n");
        known_failure(3, stdout.as_bytes(), b"", expected);
    }
    known_failure(
        3,
        b"\nDF_IMAGE_SIZE:{{TOKEN}}:1:31\n",
        b"",
        "工具依赖失败：设备截图文件大小查询失败",
    );
    known_failure(
        3,
        b"\nDF_SIZE_REJECTED:{{TOKEN}}\n",
        b"",
        "工具依赖失败：设备截图文件资格查询失败",
    );
}

#[test]
fn screenshot_size_allows_ascii_padding_without_changing_decoded_length() {
    let bytes = jpeg();
    let case = Screenshot::new("screenshot-size-whitespace", &bytes);
    case.normal_plan();
    case.overwrite(3, b"\nDF_IMAGE_SIZE:{{TOKEN}}:0: \t31 \t\r\n", b"", 0);
    let running = case.begin(Duration::from_secs(20));
    case.advance_to(5);
    assert_success(&case, &running.complete(), &bytes);
}

#[test]
fn screenshot_each_confirmed_stage_prioritizes_failure_diagnostics_on_both_streams() {
    for (ordinal, valid) in [PROBE, CAPTURE, SIZE, READ].into_iter().enumerate() {
        let ordinal = ordinal + 1;
        for stderr in [false, true] {
            let mut stdout = Vec::new();
            if !stderr {
                if ordinal == 4 {
                    stdout.extend_from_slice(b"\n");
                }
                stdout.extend_from_slice(b"[Fail] independent screenshot failure\n");
            }
            stdout.extend_from_slice(valid);
            known_failure(
                ordinal,
                &stdout,
                if stderr {
                    b"[FAIL] independent screenshot failure"
                } else {
                    b""
                },
                "工具依赖失败：HDC返回失败诊断",
            );
        }
    }
}

#[test]
fn screenshot_base64_rejects_alphabet_padding_tail_bits_and_length_after_reader_done() {
    for (body, expected) in [
        (
            b"!!!!".as_slice(),
            "输入无效：截图Base64包含非规范字符或padding",
        ),
        (b"A".as_slice(), "输入无效：截图Base64长度或设备大小不一致"),
        (
            b"AAA".as_slice(),
            "输入无效：截图Base64长度或设备大小不一致",
        ),
        (
            b"AB==".as_slice(),
            "输入无效：截图Base64尾部位或padding无效",
        ),
        (
            b"AAB=".as_slice(),
            "输入无效：截图Base64尾部位或padding无效",
        ),
        (
            b"AA=A".as_slice(),
            "输入无效：截图Base64尾部位或padding无效",
        ),
        (
            b"AA==AAAA".as_slice(),
            "输入无效：截图Base64包含padding后内容",
        ),
        (
            b"AA\nA".as_slice(),
            "输入无效：截图Base64包含非规范字符或padding",
        ),
        (
            b"AAA ".as_slice(),
            "输入无效：截图Base64包含非规范字符或padding",
        ),
        (
            b"AAA\t".as_slice(),
            "输入无效：截图Base64包含非规范字符或padding",
        ),
        (
            b"AA==".as_slice(),
            "输入无效：截图Base64长度或设备大小不一致",
        ),
    ] {
        let case = Screenshot::new("screenshot-base64-rule", &jpeg());
        case.normal_plan();
        case.body(body);
        let running = case.begin(Duration::from_secs(20));
        case.advance_to(5);
        assert_failure(&running.complete(), expected, "complete");
        case.assert_no_output();
        case.assert_no_remote();
        case.fixture.assert_calls(5);
    }
}

#[test]
fn screenshot_completed_reader_nonzero_and_stderr_utf8_do_not_publish() {
    known_failure(
        4,
        b"\nDF_READ_DONE:{{TOKEN}}:1\n",
        b"",
        "工具依赖失败：设备Base64回传执行失败",
    );
    for (ordinal, valid) in [PROBE, CAPTURE, SIZE, READ].into_iter().enumerate() {
        known_failure(
            ordinal + 1,
            valid,
            &[0xff],
            "工具依赖失败：HDC输出不是有效UTF-8",
        );
    }
}

#[test]
fn screenshot_decoded_jpeg_structure_failure_cleans_all_owned_resources() {
    for (bytes, expected) in [
        (
            b"not a JPEG".to_vec(),
            "输入无效：JPEG结构无效、截断或包含尾随内容",
        ),
        (
            jpeg()[..jpeg().len() - 2].to_vec(),
            "输入无效：JPEG结构无效、截断或包含尾随内容",
        ),
        (
            [jpeg(), b"tail".to_vec()].concat(),
            "输入无效：JPEG结构无效、截断或包含尾随内容",
        ),
        (
            {
                let mut bytes = jpeg();
                bytes[3] = 0xc1;
                bytes
            },
            "输入无效：JPEG不支持该编码结构",
        ),
    ] {
        let case = Screenshot::new("screenshot-jpeg-rule", &bytes);
        case.normal_plan();
        let running = case.begin(Duration::from_secs(20));
        case.advance_to(5);
        assert_failure(&running.complete(), expected, "complete");
        case.assert_no_output();
        case.assert_no_remote();
        case.fixture.assert_calls(5);
    }
}

#[test]
fn screenshot_declared_image_size_must_equal_actual_base64_decoded_length() {
    for (size, expected) in [
        (30, "数据超过插件限额"),
        (32, "输入无效：截图Base64长度或设备大小不一致"),
    ] {
        let case = Screenshot::new("screenshot-size-mismatch", &jpeg());
        case.normal_plan();
        let stdout = format!("\nDF_IMAGE_SIZE:{{{{TOKEN}}}}:0:{size}\n");
        case.overwrite(3, stdout.as_bytes(), b"", 0);
        let running = case.begin(Duration::from_secs(20));
        case.advance_to(5);
        assert_failure(&running.complete(), expected, "complete");
        case.assert_no_output();
        case.assert_no_remote();
        case.fixture.assert_calls(5);
    }
}

#[test]
fn screenshot_unknown_capture_late_directory_or_writer_runs_after_plugin_exit() {
    for mode in ["directory", "writer"] {
        for control in ["cancel", "eof"] {
            let case = Screenshot::new("screenshot-late-writer", &jpeg());
            case.normal_plan();
            case.set(2, "screenshot-action", b"none");
            case.set(2, "screenshot-worker", mode.as_bytes());
            let mut running = case.begin(Duration::from_secs(20));
            case.advance(1, "probe");
            let direct = case.hold(2, "capture");
            let worker = case.worker(2);
            assert!(!case.remote().exists());
            if control == "cancel" {
                running.cancel("cancelled");
            } else {
                running.eof();
            }
            let reply = running.complete();
            assert_failure(&reply, CANCELLED, "failed");
            direct.assert_exited();
            worker.assert_running();
            assert!(!case.remote().exists());
            case.fixture.assert_calls(2);
            case.assert_no_output();
            case.release_worker(2);
            worker.assert_exited();
            #[cfg(windows)]
            worker.assert_exit_code(0);
            assert_eq!(
                fs::read(case.fixture.root.join("call-02/late-writer.created")).unwrap(),
                b"1"
            );
            assert_eq!(
                fs::read(case.remote().join("owner")).unwrap(),
                format!("{}\n", case.token(1)).as_bytes()
            );
            if mode == "writer" {
                assert_eq!(
                    fs::read(case.remote().join("screenshot.jpeg")).unwrap(),
                    jpeg()
                );
            } else {
                assert!(!case.remote().join("screenshot.jpeg").exists());
            }
            assert_eq!(reply["cleanup"], "failed");
            assert!(!case.fixture.root.join("call-03").exists());
        }
    }
}

#[test]
fn screenshot_unknown_reader_keeps_real_handle_after_direct_hdc_and_plugin_exit() {
    for control in ["cancel", "eof"] {
        let case = Screenshot::new("screenshot-late-reader", &jpeg());
        case.normal_plan();
        case.set(4, "screenshot-worker", b"reader");
        let mut running = case.begin(Duration::from_secs(20));
        case.advance_to(3);
        let direct = case.hold(4, "read");
        let worker = case.worker(4);
        if control == "cancel" {
            running.cancel("cancelled");
        } else {
            running.eof();
        }
        let reply = running.complete();
        assert_failure(&reply, CANCELLED, "failed");
        direct.assert_exited();
        worker.assert_running();
        assert!(case.remote().join("screenshot.jpeg").is_file());
        case.fixture.assert_calls(4);
        case.assert_no_output();
        case.release_worker(4);
        worker.assert_exited();
        #[cfg(windows)]
        worker.assert_exit_code(0);
        assert_eq!(
            fs::read(case.fixture.root.join("call-04/late-reader.bytes")).unwrap(),
            jpeg()
        );
        assert_eq!(reply["cleanup"], "failed");
        assert!(!case.fixture.root.join("call-05").exists());
    }
}

#[test]
fn screenshot_late_worker_watchdog_is_fixed_and_has_real_os_exit() {
    let case = Screenshot::new("screenshot-worker-watchdog", &jpeg());
    case.normal_plan();
    case.set(2, "screenshot-action", b"none");
    case.set(2, "screenshot-worker", b"writer");
    let mut running = case.begin(Duration::from_secs(20));
    case.advance(1, "probe");
    let direct = case.hold(2, "capture");
    let worker = case.worker(2);
    running.cancel("cancelled");
    assert_failure(&running.complete(), CANCELLED, "failed");
    direct.assert_exited();
    let deadline = Instant::now() + Duration::from_secs(7);
    let marker = case
        .fixture
        .root
        .join("call-02/late-worker.watchdog-expired");
    while !marker.exists() {
        assert!(Instant::now() < deadline, "晚到进程固定看门狗未终态");
        thread::sleep(Duration::from_millis(5));
    }
    worker.assert_exited();
    #[cfg(windows)]
    worker.assert_exit_code(124);
    assert_eq!(fs::read(marker).unwrap(), b"1");
    assert!(!case.remote().exists());
    assert!(
        !case
            .fixture
            .root
            .join("call-02/late-writer.created")
            .exists()
    );
    case.fixture.assert_calls(2);
    case.assert_no_output();
}

fn write_large_image(path: &Path, size: usize) {
    let mut output = fs::File::create(path).unwrap();
    let seed = jpeg();
    assert!(size >= seed.len());
    output.write_all(&seed[..seed.len() - 2]).unwrap();
    let mut remaining = size - seed.len();
    let chunk = [0x55; 65_536];
    while remaining != 0 {
        let count = remaining.min(chunk.len());
        output.write_all(&chunk[..count]).unwrap();
        remaining -= count;
    }
    output.write_all(&[0xff, 0xd9]).unwrap();
    output.flush().unwrap();
    drop(output);
    assert_eq!(fs::metadata(path).unwrap().len(), size as u64);
}

fn assert_same_file(first: &Path, second: &Path) {
    assert_eq!(
        fs::metadata(first).unwrap().len(),
        fs::metadata(second).unwrap().len()
    );
    let mut first = fs::File::open(first).unwrap();
    let mut second = fs::File::open(second).unwrap();
    let mut left = [0; 65_536];
    let mut right = [0; 65_536];
    loop {
        let count = first.read(&mut left).unwrap();
        if count == 0 {
            assert_eq!(second.read(&mut right).unwrap(), 0);
            break;
        }
        second.read_exact(&mut right[..count]).unwrap();
        assert_eq!(&left[..count], &right[..count]);
    }
}

#[test]
fn screenshot_exact_64_mib_jpeg_and_encoded_limit_publish_without_whole_file_oracle() {
    let case = Screenshot::new("screenshot-exact-limit", &jpeg());
    let source = case.fixture.root.join("screenshot-source.jpeg");
    write_large_image(&source, IMAGE_LIMIT);
    case.normal_plan();
    let running = case.begin(Duration::from_secs(30));
    case.advance_to(5);
    let reply = running.complete();
    assert_success_contract(&case, &reply);
    assert_same_file(&source, &case.output.join("screenshot.jpeg"));
    let counts: Value = serde_json::from_slice(
        &fs::read(case.fixture.root.join("call-04/base64-counts.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(counts, json!({"raw":IMAGE_LIMIT,"encoded":ENCODED_LIMIT}));
    let streams: Value = serde_json::from_slice(
        &fs::read(case.fixture.root.join("call-04/stream-counts.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(streams["body"], ENCODED_LIMIT);
    assert!(streams["stdout"].as_u64().unwrap() <= FRAME_LIMIT as u64);
    assert_eq!(
        streams["stdout"],
        json!(ENCODED_LIMIT + streams["tail"].as_u64().unwrap() as usize)
    );
}

#[test]
fn screenshot_remote_64_mib_plus_one_rejects_before_base64_reader_and_clears() {
    let case = Screenshot::new("screenshot-remote-too-large", &jpeg());
    write_large_image(
        &case.fixture.root.join("screenshot-source.jpeg"),
        IMAGE_LIMIT + 1,
    );
    case.normal_plan();
    case.clear_at(4);
    let running = case.begin(Duration::from_secs(20));
    case.advance_to(3);
    case.advance(4, "clear");
    assert_failure(&running.complete(), "数据超过插件限额", "complete");
    case.fixture.assert_calls(4);
    case.assert_no_output();
    case.assert_no_remote();
    assert!(
        !case
            .fixture
            .root
            .join("call-04/base64-counts.json")
            .exists()
    );
}

fn repeated_body(case: &Screenshot, size: usize, complete_padding: bool) {
    fs::remove_file(case.fixture.root.join("plan-04/screenshot-base64")).unwrap();
    let path = case.fixture.root.join("plan-04/screenshot-body.bin");
    let mut file = fs::File::create(&path).unwrap();
    let suffix = if complete_padding { 4 } else { 0 };
    let mut remaining = size - suffix;
    let chunk = [b'A'; 65_536];
    while remaining != 0 {
        let count = remaining.min(chunk.len());
        file.write_all(&chunk[..count]).unwrap();
        remaining -= count;
    }
    if complete_padding {
        file.write_all(b"AA==").unwrap();
    }
    file.flush().unwrap();
    drop(file);
    assert_eq!(fs::metadata(path).unwrap().len(), size as u64);
}

#[test]
fn screenshot_encoded_body_limit_plus_one_with_reader_done_cleans_without_publication() {
    let case = Screenshot::new("screenshot-encoded-too-large", &jpeg());
    case.normal_plan();
    case.overwrite(3, b"\nDF_IMAGE_SIZE:{{TOKEN}}:0:67108864\n", b"", 0);
    repeated_body(&case, ENCODED_LIMIT + 1, false);
    let running = case.begin(Duration::from_secs(30));
    case.advance_to(5);
    assert_failure(&running.complete(), "数据超过插件限额", "complete");
    case.fixture.assert_calls(5);
    case.assert_no_output();
    case.assert_no_remote();
}

#[test]
fn screenshot_frame_hard_limit_plus_one_cannot_claim_remote_reader_completion() {
    let case = Screenshot::new("screenshot-frame-too-large", &jpeg());
    case.normal_plan();
    case.overwrite(3, b"\nDF_IMAGE_SIZE:{{TOKEN}}:0:67108864\n", b"", 0);
    case.overwrite(4, b"", b"", 0);
    repeated_body(&case, FRAME_LIMIT + 1, false);
    let running = case.begin(Duration::from_secs(30));
    case.advance_to(4);
    assert_failure(&running.complete(), "插件资源清理未确认", "failed");
    case.fixture.assert_calls(4);
    case.assert_no_output();
    assert!(case.remote().join("screenshot.jpeg").is_file());
}

#[test]
fn screenshot_requires_output_authorization_and_regular_absolute_existing_root() {
    for shape in 0..6 {
        let mut case = Screenshot::new("screenshot-output-authorization", &jpeg());
        let expected = match shape {
            0 => {
                case.request["artifacts"] = Value::Null;
                "输入无效：未获截图输出授权"
            }
            1 => {
                case.request["artifacts"]["output_directory"] = Value::Null;
                "输入无效：未获截图输出授权"
            }
            2 => {
                case.request["artifacts"]["output_directory"] = json!("relative-output");
                "输入无效：产物和工作路径须为无父路径的绝对路径"
            }
            3 => {
                case.request["artifacts"]["output_directory"] =
                    json!(format!("{}/../escaped", case.output.display()));
                "输入无效：产物和工作路径须为无父路径的绝对路径"
            }
            4 => {
                case.request["artifacts"]["output_directory"] =
                    json!(case.fixture.root.join("screenshot-source.jpeg"));
                "输入无效：资源路径类型不符合要求"
            }
            _ => {
                case.request["artifacts"]["output_directory"] =
                    json!(case.fixture.root.join("missing-output"));
                "文件操作失败：资源路径无法读取"
            }
        };
        assert_failure(
            &case.begin(Duration::from_secs(20)).complete(),
            expected,
            "complete",
        );
        case.fixture.assert_calls(0);
        case.assert_no_output();
    }
}

#[test]
fn screenshot_existing_authorized_output_is_never_overwritten_or_deleted() {
    let case = Screenshot::new("screenshot-existing-output", &jpeg());
    let target = case.output.join("screenshot.jpeg");
    fs::write(&target, b"preexisting-user-image").unwrap();
    case.normal_plan();
    let running = case.begin(Duration::from_secs(20));
    case.advance_to(5);
    assert_failure(
        &running.complete(),
        "文件操作失败：资源文件无法独占创建",
        "complete",
    );
    assert_eq!(fs::read(target).unwrap(), b"preexisting-user-image");
    assert_eq!(fs::read_dir(&case.output).unwrap().count(), 1);
    artifacts::empty(&case.scratch);
    case.assert_no_remote();
    case.fixture.assert_calls(5);
}

#[test]
fn screenshot_unknown_file_blocks_remote_rmdir_and_cannot_publish() {
    let case = Screenshot::new("screenshot-remote-leftover", &jpeg());
    case.normal_plan();
    case.overwrite(5, b"\nDF_CLEAR_REJECTED:{{TOKEN}}\n", b"", 0);
    case.set(5, "screenshot-action", b"clear-with-leftover");
    let running = case.begin(Duration::from_secs(20));
    case.advance_to(5);
    assert_failure(&running.complete(), "插件资源清理未确认", "failed");
    assert_eq!(
        fs::read(case.remote().join("unexpected-file")).unwrap(),
        b"fixture-owned"
    );
    assert!(!case.remote().join("owner").exists());
    assert!(!case.remote().join("screenshot.jpeg").exists());
    assert!(
        fs::read_to_string(case.fixture.root.join("call-05/remote-action.outcome"))
            .unwrap()
            .starts_with("failed:")
    );
    case.assert_no_output();
    case.fixture.assert_calls(5);
}

#[test]
fn screenshot_written_output_before_missing_clear_receipt_is_removed_without_declaration() {
    let bytes = jpeg();
    let case = Screenshot::new("screenshot-written-unpublished", &bytes);
    case.normal_plan();
    case.overwrite(5, b"", b"", 0);
    let running = case.begin(Duration::from_secs(20));
    case.advance_to(4);
    let probe = case.hold(5, "clear");
    assert_eq!(
        fs::read(case.output.join("screenshot.jpeg")).unwrap(),
        bytes
    );
    assert_eq!(
        fs::read_to_string(case.fixture.root.join("wire/stdout.jsonl"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    case.fixture.release_call(5);
    probe.assert_exited();
    assert_failure(&running.complete(), "插件资源清理未确认", "failed");
    case.assert_no_output();
    case.assert_no_remote();
    case.fixture.assert_calls(5);
}

#[cfg(windows)]
#[test]
fn screenshot_locked_written_output_reports_failed_and_does_not_delete_after_unlock() {
    use std::os::windows::fs::OpenOptionsExt;
    let bytes = jpeg();
    let case = Screenshot::new("screenshot-output-delete-denied", &bytes);
    case.normal_plan();
    case.overwrite(5, b"", b"", 0);
    let running = case.begin(Duration::from_secs(20));
    case.advance_to(4);
    let probe = case.hold(5, "clear");
    let target = case.output.join("screenshot.jpeg");
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&target)
        .unwrap();
    assert_eq!(fs::read(&target).unwrap(), bytes);
    case.fixture.release_call(5);
    probe.assert_exited();
    assert_failure(&running.complete(), "插件资源清理未确认", "failed");
    assert_eq!(fs::read(&target).unwrap(), bytes);
    case.assert_no_remote();
    case.fixture.assert_calls(5);
    drop(locked);
    thread::sleep(Duration::from_millis(100));
    assert_eq!(fs::read(&target).unwrap(), bytes);
}

#[test]
fn screenshot_nonzero_hdc_cannot_replace_unknown_remote_exit_with_local_status() {
    for (offset, stage) in ["probe", "capture", "size", "read", "clear"]
        .into_iter()
        .enumerate()
    {
        let ordinal = offset + 1;
        let case = Screenshot::new("screenshot-local-nonzero", &jpeg());
        case.normal_plan();
        case.set(ordinal, "code", b"3");
        let running = case.begin(Duration::from_secs(20));
        case.advance_to(offset);
        case.advance(ordinal, stage);
        assert_failure(&running.complete(), "插件资源清理未确认", "failed");
        case.fixture.assert_calls(ordinal);
        case.assert_no_output();
    }
}

#[test]
fn screenshot_text_and_stderr_limits_stop_without_unconfirmed_cleanup_command() {
    let oversized = vec![b'x'; 1024 * 1024 + 1];
    for (offset, stage) in ["probe", "capture", "size", "read", "clear"]
        .into_iter()
        .enumerate()
    {
        let ordinal = offset + 1;
        for stderr in [false, true] {
            if ordinal == 4 && !stderr {
                continue;
            }
            let case = Screenshot::new("screenshot-text-limit", &jpeg());
            case.normal_plan();
            case.set(
                ordinal,
                if stderr { "stderr" } else { "stdout" },
                &oversized,
            );
            let running = case.begin(Duration::from_secs(20));
            case.advance_to(offset);
            case.advance(ordinal, stage);
            assert_failure(&running.complete(), "插件资源清理未确认", "failed");
            case.fixture.assert_calls(ordinal);
            case.assert_no_output();
        }
    }
}

#[test]
fn screenshot_complete_clear_receipt_with_failure_diagnostic_keeps_cleanup_failed() {
    for stderr in [false, true] {
        let case = Screenshot::new("screenshot-clear-diagnostic", &jpeg());
        case.normal_plan();
        case.overwrite(
            5,
            if stderr {
                CLEAR
            } else {
                b"[Fail] independent clear failure\nDF_CLEARED:{{TOKEN}}\n"
            },
            if stderr {
                b"[FAIL] independent clear failure"
            } else {
                b""
            },
            0,
        );
        let running = case.begin(Duration::from_secs(20));
        case.advance_to(5);
        assert_failure(&running.complete(), "插件资源清理未确认", "failed");
        case.assert_no_remote();
        case.assert_no_output();
        case.fixture.assert_calls(5);
    }
}
