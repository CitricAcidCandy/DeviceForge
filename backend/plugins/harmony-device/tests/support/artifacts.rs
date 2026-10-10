use super::{Fixture, device};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const ARTIFACT_ID: &str = "d0da1b1b-919c-40a8-9c71-fbb56614e488";
pub const DISPLAY_NAME: &str = "独立 测试.HAP";
pub const FILE_LIMIT: usize = 64 * 1024 * 1024;

pub fn configure_scratch(fixture: &mut Fixture) -> PathBuf {
    let root = fixture.root.join("scratch");
    fs::create_dir(&root).unwrap();
    fixture.config["scratch_root"] = json!(root);
    fixture.save_config();
    root
}

pub fn installation(fixture: &Fixture, bytes: &[u8]) -> Value {
    let path = fixture.root.join("authorized-source.hap");
    fs::write(&path, bytes).unwrap();
    let mut request = fixture.request("app.install", device(json!({"artifact_id":ARTIFACT_ID})));
    request["artifacts"] = json!({"inputs":[{"field":"/input/artifact_id","artifact_id":ARTIFACT_ID,
        "filename":DISPLAY_NAME,"size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),
        "path":path}],"output_directory":null});
    request
}

pub fn empty(root: &Path) {
    assert!(root.is_dir());
    assert_eq!(
        fs::read_dir(root).unwrap().count(),
        0,
        "私有目录必须实际清空"
    );
}

pub fn sole_directory(root: &Path) -> PathBuf {
    let mut entries = fs::read_dir(root).unwrap();
    let path = entries.next().unwrap().unwrap().path();
    assert!(entries.next().is_none());
    assert!(path.is_dir());
    path
}
