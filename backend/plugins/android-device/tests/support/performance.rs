//! 独立性能文本与五笔进程门闩；不调用生产解析器或 SDK 编解码。
use super::{Fixture, PACKAGE};
use serde_json::{Value, json};
use std::time::Duration;

pub const REJECTED: &str = "工具依赖失败：设备拒绝性能采样或进程已退出";

pub fn request(fixture: &Fixture) -> Value {
    let mut request = fixture.request(
        "performance.sample",
        super::device(json!({"package":PACKAGE})),
    );
    request["artifacts"]["output_directory"] = Value::Null;
    request
}

pub fn stat(pid: u32, ticks: u64, start: u64) -> Vec<u8> {
    // /proc/<pid>/stat 的字段3为state、14/15为utime/stime、22为starttime。
    let mut fields = vec!["0".to_owned(); 20];
    fields[0] = "S".into();
    fields[11] = ticks.to_string();
    fields[12] = "8".into();
    fields[19] = start.to_string();
    format!("{pid} (app ) with (nested) name) {}\n", fields.join(" ")).into_bytes()
}

pub fn outputs() -> [Vec<u8>; 5] {
    [
        b"123\n".to_vec(),
        stat(123, 12, 900),
        b"** MEMINFO in pid 123 [com.failed.example] **\nTOTAL 42 0 0\nTOTAL PSS: 42 TOTAL RSS: 84\n".to_vec(),
        stat(123, 22, 900),
        b"cpu 10 2 3 100 4 5 6 7 900 901\ncpu0 1 2 3 4\ncpu1 1 2 3 4\n".to_vec(),
    ]
}

pub fn plan(fixture: &Fixture, outputs: &[Vec<u8>; 5]) {
    for (index, output) in outputs.iter().enumerate() {
        fixture.plan(index + 1, output, b"", 0);
    }
}

pub fn release(fixture: &Fixture, index: usize) {
    let probe = fixture.wait_tool(index);
    fixture.release(index);
    probe.assert_exited();
}

pub fn complete(fixture: &Fixture, request: Value, through: usize) -> Value {
    let mut running = fixture.begin_request(request);
    running.start(Duration::from_secs(20));
    for index in 1..=through {
        release(fixture, index);
    }
    let reply = running.complete();
    fixture.assert_calls(through);
    reply
}
