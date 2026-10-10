use super::{Fixture, device};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

pub const ARTIFACT_ID: &str = "d0da1b1b-919c-40a8-9c71-fbb56614e488";
pub const DISPLAY_NAME: &str = "独立 测试.APK";
pub const FILE_LIMIT: usize = 64 * 1024 * 1024;

pub fn configure_scratch(fixture: &mut Fixture) -> PathBuf {
    let root = fixture.root.join("private-scratch");
    fs::create_dir(&root).unwrap();
    fixture.config["scratch_root"] = json!(root);
    fixture.save_config();
    root
}

pub fn input_row(path: &Path, bytes: &[u8]) -> Value {
    json!({"field":"/input/artifact_id", "artifact_id":ARTIFACT_ID,
        "filename":DISPLAY_NAME, "size":bytes.len(),
        "sha256":format!("{:x}", Sha256::digest(bytes)), "path":path})
}

pub fn installation(fixture: &Fixture, bytes: &[u8]) -> Value {
    let path = fixture.root.join("authorized-source.apk");
    fs::write(&path, bytes).unwrap();
    let mut request = fixture.request("app.install", device(json!({"artifact_id":ARTIFACT_ID})));
    request["artifacts"] = json!({"inputs":[input_row(&path, bytes)], "output_directory":null});
    request
}

pub fn screenshot(fixture: &Fixture) -> (Value, PathBuf) {
    let root = fixture.root.join("authorized-output");
    fs::create_dir(&root).unwrap();
    let mut request = fixture.request("screenshot", device(json!({})));
    request["artifacts"]["output_directory"] = json!(root);
    (request, root)
}

pub fn png(size: usize) -> Vec<u8> {
    assert!(size >= 24);
    let mut bytes = vec![0; size];
    bytes[..16].copy_from_slice(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR");
    bytes[19] = 1;
    bytes[23] = 1;
    bytes
}

pub fn run(fixture: &Fixture, request: Value, stdout: &[u8], stderr: &[u8], code: i32) -> Value {
    fixture.plan(1, stdout, stderr, code);
    let mut running = fixture.begin_request(request);
    running.start(Duration::from_secs(20));
    let probe = fixture.wait_tool(1);
    fixture.release(1);
    let reply = running.complete();
    probe.assert_exited();
    fixture.assert_calls(1);
    reply
}

pub fn empty(root: &Path) {
    assert!(root.is_dir(), "部署或授权根必须保留");
    assert_eq!(
        fs::read_dir(root).unwrap().count(),
        0,
        "本次私有目录或失败产物须清除"
    );
}

pub fn sole_directory(root: &Path) -> PathBuf {
    let mut entries = fs::read_dir(root).unwrap();
    let path = entries.next().unwrap().unwrap().path();
    assert!(entries.next().is_none());
    assert!(path.is_dir());
    path
}

pub fn screenshot_result(reply: &Value) {
    assert_eq!(reply["cleanup"], "complete");
    assert!(reply["response"].get("error").is_none());
    assert_eq!(reply["response"]["result"], Value::Null);
    assert_eq!(
        reply["response"]["outputs"],
        json!([{"filename":"screenshot.png"}])
    );
    assert_eq!(reply["response"].as_object().unwrap().len(), 4);
}

pub fn plan_large_stdout(fixture: &Fixture, size: usize) {
    fixture.plan(1, b"", b"", 0);
    let mut output = fs::File::create(fixture.root.join("stdout-1")).unwrap();
    output.write_all(&png(45)).unwrap();
    let chunk = [0; 64 * 1024];
    let mut remaining = size - 45;
    while remaining != 0 {
        let count = remaining.min(chunk.len());
        output.write_all(&chunk[..count]).unwrap();
        remaining -= count;
    }
    output.flush().unwrap();
}
