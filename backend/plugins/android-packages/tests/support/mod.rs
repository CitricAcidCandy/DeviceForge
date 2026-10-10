//! 每例独占配置、工具观察与输出目录；失败保留本次原帧及样本。
pub mod process;
pub mod wire;
pub mod zip;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use wire::Invocation;

pub const ARTIFACT_ID: &str = "550e8400-e29b-41d4-a716-446655440000";
pub const XML: &str = r#"<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="org.fixture.app" android:versionCode="0007" android:versionName="一&amp;二"><uses-sdk android:minSdkVersion="21" android:targetSdkVersion="35"/><uses-permission android:name="android.permission.INTERNET"/><application android:label="独立样本" android:debuggable="false"/></manifest>"#;
pub const APKTOOL: &[u8] = b"version: 2.9.3\n";
pub const SMALI: &[u8] = b".class public Lcom/example/sdk/Probe;\n\x00\xff";

pub fn apk() -> Vec<u8> {
    zip::stored(&[
        ("AndroidManifest.xml", b"\x03\x00fixture\x00\xff"),
        ("classes.dex", b"dex\n035\0fixture"),
    ])
}
pub fn aab() -> Vec<u8> {
    zip::stored(&[
        ("base/manifest/AndroidManifest.xml", b"fixture-protobuf"),
        ("BundleConfig.pb", b"fixture"),
    ])
}
pub fn apks() -> Vec<u8> {
    let body = apk();
    zip::stored(&[("universal.apk", &body), ("toc.pb", b"fixture-toc")])
}
pub fn decoded() -> Vec<u8> {
    zip::stored(&[
        ("AndroidManifest.xml", XML.as_bytes()),
        ("apktool.yml", APKTOOL),
        ("smali/com/example/sdk/Probe.smali", SMALI),
    ])
}
pub fn signature() -> String {
    format!(
        "Verifies\nVerified using v2 scheme (APK Signature Scheme v2): true\nNumber of signers: 1\nSigner #1 certificate SHA-256 digest: {}\n",
        "AB".repeat(32)
    )
}
pub fn device_spec() -> Value {
    json!({"supported_abis":["arm64-v8a"],"supported_locales":["zh-CN"],"screen_density":420,"sdk_version":35})
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct CompiledTool {
    _directory: TempDir,
    executable: PathBuf,
}
static TOOL: OnceLock<CompiledTool> = OnceLock::new();
fn compiled_tool() -> &'static Path {
    &TOOL
        .get_or_init(|| {
            let directory = tempfile::tempdir().unwrap();
            let executable = directory.path().join(if cfg!(windows) {
                "fixed-tool.exe"
            } else {
                "fixed-tool"
            });
            let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tool.rs");
            let output = Command::new("rustc")
                .args(["--edition=2024", "--crate-name=independent_package_tool"])
                .arg(source)
                .arg("-o")
                .arg(&executable)
                .output()
                .expect("测试执行时通过 rustc 编译 std-only 夹具");
            assert!(
                output.status.success(),
                "独立工具编译失败：{}",
                String::from_utf8_lossy(&output.stderr)
            );
            CompiledTool {
                _directory: directory,
                executable,
            }
        })
        .executable
}

pub struct Fixture {
    directory: Option<TempDir>,
    pub root: PathBuf,
    pub tools: PathBuf,
    pub scratch: PathBuf,
    pub output: PathBuf,
    pub config_path: PathBuf,
    pub input_path: PathBuf,
    pub input_name: String,
    pub input_bytes: Vec<u8>,
    pub config: Value,
}
impl Fixture {
    pub fn new(name: &str, bytes: Vec<u8>) -> Self {
        let directory = tempfile::Builder::new()
            .prefix("android-protocol-")
            .tempdir()
            .unwrap();
        let root = directory.path().canonicalize().unwrap();
        let tools = root.join("工具 空格&$()");
        let scratch = root.join("私有任务");
        let output = root.join("宿主输出");
        for path in [&tools, &scratch, &output] {
            fs::create_dir(path).unwrap();
        }
        let executable = tools.join(if cfg!(windows) { "tool.exe" } else { "tool" });
        fs::copy(compiled_tool(), &executable).unwrap();
        for file in [
            "bundletool.jar",
            "apktool.jar",
            "keystore.jks",
            "store.pass",
            "key.pass",
        ] {
            fs::write(tools.join(file), b"only-fixture-data").unwrap();
        }
        fs::write(tools.join("mode.txt"), "hold").unwrap();
        fs::write(tools.join("manifest.xml"), XML).unwrap();
        fs::write(tools.join("signature.txt"), signature()).unwrap();
        fs::write(tools.join("universal.apks"), apks()).unwrap();
        let inner = apk();
        fs::write(
            tools.join("default.apks"),
            zip::stored(&[
                ("splits/base-master.apk", &inner),
                ("toc.pb", b"fixture-toc"),
            ]),
        )
        .unwrap();
        fs::write(tools.join("base-master.apk"), &inner).unwrap();
        fs::write(tools.join("base-arm64.apk"), &inner).unwrap();
        fs::write(tools.join("decoded-manifest.xml"), XML).unwrap();
        fs::write(tools.join("apktool.yml"), APKTOOL).unwrap();
        fs::write(tools.join("Probe.smali"), SMALI).unwrap();
        fs::write(tools.join("expected-input.bin"), &bytes).unwrap();
        let config = json!({"format_version":1,"tools":{"java":executable,
            "apkanalyzer":{"kind":"executable","executable":executable},
            "apksigner":{"kind":"executable","executable":executable},
            "bundletool":{"kind":"java_jar","jar":tools.join("bundletool.jar")},
            "apktool":{"kind":"java_jar","jar":tools.join("apktool.jar")}},
            "signing":{"keystore":tools.join("keystore.jks"),"alias":"fixture_中文_&$()",
                "store_password_file":tools.join("store.pass"),"key_password_file":tools.join("key.pass")},
            "scratch_root":scratch});
        let config_path = root.join("部署配置.json");
        fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        let input_path = root.join(name);
        fs::write(&input_path, &bytes).unwrap();
        Self {
            directory: Some(directory),
            root,
            tools,
            scratch,
            output,
            config_path,
            input_path,
            input_name: name.to_owned(),
            input_bytes: bytes,
            config,
        }
    }
    pub fn save_config(&self) {
        fs::write(&self.config_path, serde_json::to_vec(&self.config).unwrap()).unwrap();
    }
    pub fn metadata(&self) -> Value {
        json!({"field":"artifact_id","artifact_id":ARTIFACT_ID,
        "filename":self.input_name,"size":self.input_bytes.len(),"sha256":hash(&self.input_bytes),"path":self.input_path})
    }
    pub fn request(&self, operation: &str, mut input: Value) -> Value {
        input["artifact_id"] = json!(ARTIFACT_ID);
        json!({"protocol_version":4,"request_id":format!("blackbox-{operation}"),"operation":operation,"input":input,
            "artifacts":{"inputs":[self.metadata()],"output_directory":self.output}})
    }
    pub fn begin(&self, operation: &str, input: Value) -> Invocation {
        self.begin_request(self.request(operation, input))
    }
    pub fn begin_request(&self, request: Value) -> Invocation {
        Invocation::spawn(&self.config_path, &self.root, request)
    }
    pub fn wait_tool(&self) -> process::PidProbe {
        let limit = Instant::now() + Duration::from_secs(8);
        while !self.tools.join("ready.pid").exists() {
            assert!(Instant::now() < limit, "真实工具没有到达本次 ready 门闩");
            thread::sleep(Duration::from_millis(5));
        }
        let pid = fs::read_to_string(self.tools.join("ready.pid"))
            .unwrap()
            .parse()
            .unwrap();
        let probe = process::PidProbe::open(pid);
        probe.assert_running();
        probe
    }
    pub fn release(&self) {
        fs::write(self.tools.join("release"), b"1").unwrap();
    }
    pub fn normal(&self, operation: &str, input: Value, needs_tool: bool) -> Value {
        let mut process = self.begin(operation, input);
        process.start(Duration::from_secs(20));
        let probe = needs_tool.then(|| self.wait_tool());
        if needs_tool {
            self.release();
        }
        let reply = process.complete();
        if let Some(probe) = probe {
            probe.assert_exited();
        }
        self.assert_released();
        reply
    }
    pub fn assert_no_tool(&self) {
        assert!(
            !self.tools.join("started.pid").exists(),
            "预拒绝应零工具启动"
        );
    }
    pub fn assert_no_output(&self) {
        assert_eq!(
            fs::read_dir(&self.output).unwrap().count(),
            0,
            "失败不复制宿主输出"
        );
    }
    pub fn assert_released(&self) {
        assert_eq!(
            fs::read_dir(&self.scratch).unwrap().count(),
            0,
            "本次私有目录必须真实删除后才能complete"
        );
        assert_eq!(
            fs::read(&self.input_path).unwrap(),
            self.input_bytes,
            "插件不修改宿主输入副本"
        );
        for file in [
            "keystore.jks",
            "store.pass",
            "key.pass",
            "bundletool.jar",
            "apktool.jar",
        ] {
            assert_eq!(
                fs::read(self.tools.join(file)).unwrap(),
                b"only-fixture-data",
                "部署者长期资源不能被删除或修改"
            );
        }
    }
    pub fn argv(&self) -> Vec<String> {
        fs::read_to_string(self.tools.join("argv.txt"))
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }
    pub fn assert_private_input(&self) {
        let path = PathBuf::from(fs::read_to_string(self.tools.join("input-path.txt")).unwrap());
        assert_ne!(path, self.input_path, "工具不能直接获得宿主副本");
        assert!(path.starts_with(&self.scratch), "工具只接本次独占私有目录");
        assert!(!path.starts_with(&self.output));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if std::thread::panicking() {
            let retained = self.directory.take().unwrap().keep();
            eprintln!("独立安卓原帧失败证据保留：{}", retained.display());
        }
    }
}
