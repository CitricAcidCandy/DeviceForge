//! 专用Harmony装配的真实假HDC回归，不运行ADB或连接真机。
use super::*;
use apk_domain::ExecutionContext;
use std::{path::PathBuf, sync::OnceLock};

const SOURCE: &str = r#"
// 假HDC只接受原两类固定argv；任何其它工具命令均失败。
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let marker = std::env::current_exe().unwrap().parent().unwrap().join("hdc-argv");
    std::fs::write(marker, args.join("|" )).unwrap();
    if args == ["list", "targets"] {
        print!("[Empty]\n HDC001 \ninvalid device\nHDC002\n");
        return;
    }
    assert_eq!(args.len(), 6);
    assert_eq!(args[0], "-t");
    assert_eq!(&args[2..], &["shell", "bm", "dump", "-a"]);
    match args[1].as_str() {
        "HDC001" => print!("  bundle:com.example.app\n"),
        "diagnostic" => print!("cannot read packages"),
        "exit" => std::process::exit(7),
        _ => panic!("不允许的设备标识"),
    }
}
"#;

fn tool() -> &'static str {
    static TOOL: OnceLock<(tempfile::TempDir, String)> = OnceLock::new();
    &TOOL
        .get_or_init(|| {
            let directory = tempfile::tempdir().unwrap();
            let source = directory.path().join("fake-hdc.rs");
            let executable = directory.path().join(if cfg!(windows) {
                "fake-hdc.exe"
            } else {
                "fake-hdc"
            });
            std::fs::write(&source, SOURCE).unwrap();
            let output = std::process::Command::new("rustc")
                .arg(&source)
                .arg("-o")
                .arg(&executable)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            (directory, executable.to_string_lossy().into_owned())
        })
        .1
}

async fn setup() -> (tempfile::TempDir, HarmonyDeviceTools, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let executable = directory
        .path()
        .join(if cfg!(windows) { "hdc.exe" } else { "hdc" });
    tokio::fs::copy(tool(), &executable).await.unwrap();
    let marker = directory.path().join("hdc-argv");
    (
        directory,
        HarmonyDeviceTools {
            hdc: executable.to_string_lossy().into_owned(),
        },
        marker,
    )
}

#[test]
fn declares_only_the_two_original_harmony_contributions() {
    let tools = HarmonyDeviceTools {
        hdc: "unused".into(),
    };
    let operations = tools.operations();
    assert_eq!(
        operations
            .iter()
            .map(|operation| operation.id.as_str())
            .collect::<Vec<_>>(),
        ["harmony.packages", "harmony.devices"]
    );
    assert_eq!(
        operations[0].input_schema,
        json!({"type":"object","properties":{"device_id":{"type":"string","minLength":1,"maxLength":200}},"required":["device_id"],"additionalProperties":false})
    );
    assert_eq!(
        operations[1].input_schema,
        json!({"type":"object","additionalProperties":false})
    );
    assert!(
        operations
            .iter()
            .all(|operation| operation.execution.is_none())
    );
}

#[tokio::test]
async fn both_entrypoints_reject_android_before_any_hdc_process() {
    let (_directory, tools, marker) = setup().await;
    for operation in [
        "android.devices",
        "android.connect",
        "android.disconnect",
        "android.packages",
        "android.app.start",
        "android.app.stop",
        "android.app.uninstall",
        "android.input",
        "plugin.android-device.discover",
    ] {
        for with_context in [false, true] {
            for pre_cancel in [false, true] {
                let cancel = CancellationToken::new();
                if pre_cancel {
                    cancel.cancel();
                }
                let result = if with_context {
                    tools
                        .execute_with_context(
                            operation,
                            json!({}),
                            cancel,
                            ExecutionContext::default(),
                        )
                        .await
                } else {
                    tools.execute(operation, json!({}), cancel).await
                };
                assert!(matches!(result, Err(Error::NotFound(ref value)) if value == operation));
            }
        }
    }
    assert!(!marker.exists());
}

#[tokio::test]
async fn discovery_uses_list_targets_and_keeps_original_hdc_filtering() {
    let (_directory, tools, marker) = setup().await;
    let devices = tools
        .execute("harmony.devices", json!({}), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        devices,
        json!([
            {"id":"HDC001","platform":"harmony","state":"device","model":null},
            {"id":"HDC002","platform":"harmony","state":"device","model":null},
        ])
    );
    assert_eq!(
        tokio::fs::read_to_string(marker).await.unwrap(),
        "list|targets"
    );
}

#[tokio::test]
async fn packages_preserve_fixed_hdc_arguments_and_trimmed_output() {
    let (_directory, tools, marker) = setup().await;
    let result = tools
        .execute_with_context(
            "harmony.packages",
            json!({"device_id":"HDC001"}),
            CancellationToken::new(),
            ExecutionContext::default(),
        )
        .await
        .unwrap();
    assert_eq!(result, json!({"output":"bundle:com.example.app"}));
    assert_eq!(
        tokio::fs::read_to_string(marker).await.unwrap(),
        "-t|HDC001|shell|bm|dump|-a"
    );
}

#[tokio::test]
async fn packages_retain_original_diagnostic_and_exit_failures() {
    let (_directory, tools, _marker) = setup().await;
    for device in ["diagnostic", "exit"] {
        assert!(matches!(
            tools
                .execute(
                    "harmony.packages",
                    json!({"device_id":device}),
                    CancellationToken::new()
                )
                .await,
            Err(Error::Dependency(_))
        ));
    }
}

#[tokio::test]
async fn invalid_hdc_device_identifier_never_starts_the_tool() {
    let (_directory, tools, marker) = setup().await;
    assert!(matches!(
        tools
            .execute(
                "harmony.packages",
                json!({"device_id":"invalid device"}),
                CancellationToken::new()
            )
            .await,
        Err(Error::Invalid(_))
    ));
    assert!(!marker.exists());
}
