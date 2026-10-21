//! 真实插件进程验证协议 4、固定旁置配置和业务输入拒绝。
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

struct Deployment {
    _directory: tempfile::TempDir,
    executable: PathBuf,
    root: PathBuf,
}
impl Deployment {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let source = Path::new(env!("CARGO_BIN_EXE_deviceforge-tool-supply-plugin"));
        let executable = directory.path().join(source.file_name().unwrap());
        fs::copy(source, &executable).unwrap();
        let root = directory.path().join("tools");
        fs::write(
            directory.path().join("tool-catalog.json"),
            serde_json::to_vec(&json!({"manifestVersion":"test-1","modules":[]})).unwrap(),
        )
        .unwrap();
        fs::write(
            directory.path().join("tool-supply.config.json"),
            serde_json::to_vec(&json!({
            "local_manifest":"tool-catalog.json","install_root":root,"allow_http":false}))
            .unwrap(),
        )
        .unwrap();
        Self {
            _directory: directory,
            executable,
            root,
        }
    }
    async fn request(&self, operation: &str, input: Value) -> Value {
        self.request_with_artifacts(operation, input, None).await
    }
    async fn request_with_artifacts(
        &self,
        operation: &str,
        input: Value,
        artifacts: Option<Value>,
    ) -> Value {
        let mut child = Command::new(&self.executable)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut stderr = child.stderr.take().unwrap();
        let diagnostics = tokio::spawn(async move {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).await.unwrap();
            bytes
        });
        let mut request = json!({"protocol_version":4,"request_id":"tool-business","operation":operation,"input":input});
        if let Some(artifacts) = artifacts {
            request["artifacts"] = artifacts;
        }
        stdin
            .write_all(format!("{}\n", request).as_bytes())
            .await
            .unwrap();
        // Windows管道写入必须刷新，不能用延长超时掩盖请求仍未送达。
        stdin.flush().await.unwrap();
        let mut line = String::new();
        match tokio::time::timeout(Duration::from_secs(10), stdout.read_line(&mut line)).await {
            Ok(Ok(count)) if count > 0 => (),
            failure => {
                let before_kill = child.try_wait().unwrap();
                let _ = child.kill().await;
                drop(stdin);
                let _ = child.wait().await;
                let diagnostics = diagnostics.await.unwrap();
                panic!(
                    "Ready未收到：{failure:?}；终止前状态={before_kill:?}；stderr={}",
                    String::from_utf8_lossy(&diagnostics)
                );
            }
        }
        let ready: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(ready["protocol_version"], 4);
        assert_eq!(ready["request_id"], "tool-business");
        assert_eq!(ready["command"], "ready");
        stdin.write_all(b"{\"protocol_version\":4,\"request_id\":\"tool-business\",\"command\":\"start\",\"remaining_timeout_ns\":5000000000}\n").await.unwrap();
        stdin.flush().await.unwrap();
        line.clear();
        tokio::time::timeout(Duration::from_secs(10), stdout.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        let response = serde_json::from_str(&line).unwrap();
        // 响应已完整到达，关闭输入使标准输入阻塞工作能够真实退出。
        drop(stdin);
        let status = tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success());
        let diagnostics = diagnostics.await.unwrap();
        assert!(
            diagnostics.is_empty(),
            "stderr={}",
            String::from_utf8_lossy(&diagnostics)
        );
        response
    }
}

#[tokio::test]
async fn actual_protocol_four_process_plans_from_deployer_sidecar() {
    let deployment = Deployment::new();
    let response = deployment.request("plan", json!({})).await;
    assert_eq!(response["response"]["protocol_version"], 4);
    assert_eq!(response["response"]["request_id"], "tool-business");
    assert_eq!(response["cleanup"], "complete");
    assert!(response["response"]["error"].is_null());
    assert_eq!(response["response"]["result"]["manifest_version"], "test-1");
    assert_eq!(response["response"]["result"]["download_bytes"], 0);
    assert_eq!(response["response"]["result"]["modules"], json!([]));
    assert!(deployment.root.is_dir());
}
#[tokio::test]
async fn actual_protocol_rejects_request_path_override_before_deployment_io() {
    let deployment = Deployment::new();
    let response = deployment
        .request(
            "install",
            json!({"module_id":"adb","install_root":"forbidden"}),
        )
        .await;
    assert_eq!(response["cleanup"], "complete");
    assert!(response["response"]["result"].is_null());
    assert!(
        response["response"]["error"]
            .as_str()
            .unwrap()
            .contains("输入")
    );
    assert!(!deployment.root.exists(), "业务输入拒绝早于创建部署根目录");
}

#[tokio::test]
async fn actual_protocol_imports_authorized_archive_without_a_live_manifest_or_download() {
    use sha2::{Digest, Sha256};
    use std::io::{Cursor, Write};
    let deployment = Deployment::new();
    fs::remove_file(deployment._directory.path().join("tool-catalog.json")).unwrap();
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .start_file("tool.txt", zip::write::SimpleFileOptions::default())
        .unwrap();
    archive.write_all(b"local bytes").unwrap();
    let bytes = archive.finish().unwrap().into_inner();
    let path = deployment._directory.path().join("local.zip");
    fs::write(&path, &bytes).unwrap();
    let checksum = format!("{:x}", Sha256::digest(&bytes));
    let id = "12345678-1234-4234-8234-123456789abc";
    let input = json!({"archive_artifact_id":id,"module_id":"demo",
        "manifest":{"manifestVersion":"local-1","modules":[{"name":"demo","version":"1.0",
            "url":"https://127.0.0.1:9/unavailable.zip","size":bytes.len(),"sha256":checksum,"entryFile":"tool.txt"}]}});
    let artifacts = json!({"inputs":[{"field":"/archive_artifact_id","artifact_id":id,
        "filename":"local.zip","size":bytes.len(),"sha256":checksum,"path":path}],"output_directory":null});
    for expected in [true, false] {
        let response = deployment
            .request_with_artifacts("import", input.clone(), Some(artifacts.clone()))
            .await;
        assert_eq!(response["cleanup"], "complete");
        assert!(response["response"]["error"].is_null(), "{response}");
        let result = &response["response"]["result"];
        assert_eq!(result["changed"], expected);
        assert_eq!(result["sha256"], checksum);
        assert_eq!(result.as_object().unwrap().len(), 4);
        assert_eq!(
            fs::read(deployment.root.join("demo/tool.txt")).unwrap(),
            b"local bytes"
        );
    }
}
