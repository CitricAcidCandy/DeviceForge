use super::*;
use apk_plugin_sdk::ArtifactContext;

fn request(path: String, size: u64) -> Request {
    Request {
        protocol_version: ARTIFACT_PROTOCOL_VERSION,
        request_id: "test".into(),
        operation: "encode".into(),
        input: json!({"artifact_id":"id"}),
        artifacts: Some(ArtifactContext {
            inputs: vec![ArtifactInput {
                field: "artifact_id".into(),
                artifact_id: "id".into(),
                filename: "data.json".into(),
                size,
                sha256: String::new(),
                path,
            }],
            output_directory: None,
        }),
    }
}
#[test]
fn protocol_context_and_authorized_size_are_required() {
    let mut value = request(String::new(), MAX_BYTES as u64 + 1);
    assert!(execute(&value).unwrap_err().contains("16 MiB"));
    value.protocol_version = 1;
    assert!(execute(&value).unwrap_err().contains("版本 2"));
    value.protocol_version = 2;
    value.artifacts.as_mut().unwrap().inputs[0].artifact_id = "other".into();
    assert!(execute(&value).unwrap_err().contains("不一致"));
    value.artifacts.as_mut().unwrap().inputs.clear();
    assert!(execute(&value).unwrap_err().contains("一个输入"));
    value.artifacts = None;
    assert!(execute(&value).unwrap_err().contains("上下文"));
}
#[test]
fn input_copy_size_and_output_creation_never_overwrite_existing_files() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source.json");
    std::fs::write(&path, b"[]").unwrap();
    let mut value = request(path.to_string_lossy().into_owned(), 1);
    assert!(execute(&value).unwrap_err().contains("大小"));
    let context = value.artifacts.as_mut().unwrap();
    context.inputs[0].size = 2;
    context.output_directory = Some(directory.path().to_string_lossy().into_owned());
    let output = directory.path().join("converted.msgpack");
    std::fs::write(&output, b"existing").unwrap();
    assert!(execute(&value).unwrap_err().contains("创建"));
    assert_eq!(std::fs::read(output).unwrap(), b"existing");
}
