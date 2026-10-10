use crate::support::{
    Fixture, SERIAL,
    artifacts::{self, ARTIFACT_ID, DISPLAY_NAME, FILE_LIMIT},
    failure, success,
};
use serde_json::json;
use std::{fs, path::Path, time::Duration};

#[test]
fn installation_uses_exclusive_closed_private_copy_and_does_not_require_output_root() {
    let mut fixture = Fixture::new("install-private-copy");
    let scratch = artifacts::configure_scratch(&mut fixture);
    let bytes = b"independent authorized APK bytes";
    let request = artifacts::installation(&fixture, bytes);
    fixture.plan(1, b"unused", b"", 0);
    fs::write(fixture.root.join("echo-install-path-1"), b"1").unwrap();
    let mut running = fixture.begin_request(request);
    running.start(Duration::from_secs(20));
    let probe = fixture.wait_tool(1);
    let args = fixture.argv(1);
    assert_eq!(&args[..3], &["-s", SERIAL, "install"]);
    assert_eq!(args.len(), 4);
    let private = Path::new(&args[3]);
    assert_eq!(private.file_name().unwrap(), "input.apk");
    assert_eq!(private.parent().unwrap().parent().unwrap(), scratch);
    assert!(private.is_absolute());
    assert_ne!(private, fixture.root.join("authorized-source.apk"));
    assert_eq!(fs::read(private).unwrap(), bytes);
    assert_eq!(
        fs::read(fixture.root.join("call-01/install-input.bin")).unwrap(),
        bytes
    );
    fs::write(
        fixture.root.join("authorized-source.apk"),
        b"changed after private preparation",
    )
    .unwrap();
    assert_eq!(fs::read(private).unwrap(), bytes);
    fixture.release(1);
    let reply = running.complete();
    probe.assert_exited();
    assert_eq!(
        success(&reply),
        &json!({"artifact_id":ARTIFACT_ID,"output":format!("Installed {DISPLAY_NAME}\nSuccess")})
    );
    assert!(!serde_json::to_string(&reply).unwrap().contains(&args[3]));
    assert!(!fixture.root.join("unused-output").exists());
    assert!(!private.exists());
    artifacts::empty(&scratch);
    fixture.assert_calls(1);
}

#[test]
fn installation_accepts_uppercase_sha256_and_64_mib_exact_boundary() {
    let mut fixture = Fixture::new("install-size-equal");
    let scratch = artifacts::configure_scratch(&mut fixture);
    let bytes = vec![0x5a; FILE_LIMIT];
    let mut request = artifacts::installation(&fixture, &bytes);
    let hash = request["artifacts"]["inputs"][0]["sha256"]
        .as_str()
        .unwrap()
        .to_ascii_uppercase();
    request["artifacts"]["inputs"][0]["sha256"] = json!(hash);
    let reply = artifacts::run(&fixture, request, b"Success\n", b"", 0);
    assert_eq!(
        success(&reply),
        &json!({"artifact_id":ARTIFACT_ID,"output":"Success"})
    );
    assert_eq!(
        fs::metadata(fixture.root.join("call-01/install-input.bin"))
            .unwrap()
            .len(),
        FILE_LIMIT as u64
    );
    artifacts::empty(&scratch);
}

#[test]
fn installation_length_and_hash_mismatch_do_not_start_adb_and_clean_private_directory() {
    for (key, value, expected) in [
        ("size", json!(1), "输入无效：输入产物长度不一致"),
        (
            "sha256",
            json!("0".repeat(64)),
            "输入无效：输入产物大小或SHA256不一致",
        ),
    ] {
        let mut fixture = Fixture::new("install-integrity");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let mut request = artifacts::installation(&fixture, b"real source bytes");
        request["artifacts"]["inputs"][0][key] = value;
        let mut running = fixture.begin_request(request);
        running.start(Duration::from_secs(20));
        failure(&running.complete(), expected);
        fixture.assert_no_tool();
        artifacts::empty(&scratch);
    }
}

#[test]
fn installation_source_requires_absolute_regular_existing_path() {
    for shape in 0..4 {
        let mut fixture = Fixture::new("install-source-path");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let mut request = artifacts::installation(&fixture, b"source");
        let (path, expected) = match shape {
            0 => (
                json!("authorized-source.apk"),
                "输入无效：产物和工作路径须为无父路径的绝对路径",
            ),
            1 => (
                json!(format!("{}/../escape.apk", fixture.root.display())),
                "输入无效：产物和工作路径须为无父路径的绝对路径",
            ),
            2 => (json!(fixture.root), "输入无效：资源路径类型不符合要求"),
            _ => (
                json!(fixture.root.join("missing-source.apk")),
                "文件操作失败：资源路径无法读取",
            ),
        };
        request["artifacts"]["inputs"][0]["path"] = path;
        let mut running = fixture.begin_request(request);
        running.start(Duration::from_secs(20));
        failure(&running.complete(), expected);
        fixture.assert_no_tool();
        artifacts::empty(&scratch);
    }
}

#[test]
fn installation_success_is_independent_line_and_failure_in_either_stream_wins() {
    for (stdout, stderr) in [
        (b"NotSuccess\n".as_slice(), b"".as_slice()),
        (b"Success suffix\n".as_slice(), b"".as_slice()),
        (b"Success\nFailure [DENIED]\n".as_slice(), b"".as_slice()),
        (
            b"Success\n".as_slice(),
            b"adb: error: private device diagnostic".as_slice(),
        ),
        (b"".as_slice(), b"failed\nSuccess\n".as_slice()),
    ] {
        let mut fixture = Fixture::new("install-diagnostic");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let request = artifacts::installation(&fixture, b"source");
        failure(
            &artifacts::run(&fixture, request, stdout, stderr, 0),
            "工具依赖失败：ADB安装未返回明确成功结果",
        );
        artifacts::empty(&scratch);
    }
}

#[test]
fn installation_merges_stdout_and_stderr_success() {
    let mut fixture = Fixture::new("install-merged-success");
    let scratch = artifacts::configure_scratch(&mut fixture);
    let request = artifacts::installation(&fixture, b"source");
    let reply = artifacts::run(&fixture, request, b" streamed\n", b"Success\n", 0);
    assert_eq!(
        success(&reply),
        &json!({"artifact_id":ARTIFACT_ID,"output":"streamed\n\nSuccess"})
    );
    artifacts::empty(&scratch);
}

#[test]
fn installation_invalid_utf8_in_each_stream_and_nonzero_exit_are_fixed_errors() {
    for (stdout, stderr, code, expected) in [
        (
            &[0xff][..],
            b"Success\n".as_slice(),
            0,
            "工具依赖失败：ADB安装输出不是有效UTF-8",
        ),
        (
            b"Success\n".as_slice(),
            &[0xfe][..],
            0,
            "工具依赖失败：ADB安装输出不是有效UTF-8",
        ),
        (
            b"Success\n".as_slice(),
            b"".as_slice(),
            7,
            "工具依赖失败：ADB客户端执行失败，请检查部署配置",
        ),
    ] {
        let mut fixture = Fixture::new("install-stream-error");
        let scratch = artifacts::configure_scratch(&mut fixture);
        let request = artifacts::installation(&fixture, b"source");
        failure(
            &artifacts::run(&fixture, request, stdout, stderr, code),
            expected,
        );
        artifacts::empty(&scratch);
    }
}
