//! APKS 公开帧、独立手工 ZIP 与假 Java 证据；不使用生产解析器生成期望。
use crate::support::{
    CANCELLED, Fixture, SERIAL, TOTAL_TIMEOUT, apks,
    artifacts::{self, ARTIFACT_ID, FILE_LIMIT},
    failure, success,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

const INVALID_APKS: &str = "输入无效：APKS外层结构、成员长度或CRC无效";

fn configured(label: &str) -> (Fixture, PathBuf, PathBuf) {
    let mut fixture = Fixture::new(label);
    let scratch = artifacts::configure_scratch(&mut fixture);
    let jar = apks::configure(&mut fixture);
    (fixture, scratch, jar)
}

fn reject(fixture: &Fixture, request: Value, expected: &str, scratch: &Path) {
    let mut running = fixture.begin_request(request);
    running.start(Duration::from_secs(20));
    failure(&running.complete(), expected);
    fixture.assert_no_tool();
    artifacts::empty(scratch);
}

#[test]
fn apks_uses_fixed_java_argv_closed_private_copy_and_private_environment() {
    let (fixture, scratch, jar) = configured("apks-private-command");
    let bytes = apks::sample();
    let request = apks::request(&fixture, &bytes);
    fixture.plan(1, b"", b"", 0);
    let mut running = fixture.begin_request(request);
    running.start(Duration::from_secs(20));
    let probe = fixture.wait_tool(1);
    let args = fixture.argv(1);
    assert_eq!(args.len(), 7);
    assert_eq!(
        &args[..4],
        &["-Xmx256m", "-jar", jar.to_str().unwrap(), "install-apks"]
    );
    assert_eq!(args[5], format!("--device-id={SERIAL}"));
    assert_eq!(
        args[6],
        format!(
            "--adb={}",
            fs::canonicalize(&fixture.executable).unwrap().display()
        )
    );
    let private = Path::new(args[4].strip_prefix("--apks=").unwrap());
    assert!(private.is_absolute());
    assert_eq!(private.file_name().unwrap(), "input.apks");
    assert_eq!(private.parent().unwrap().parent().unwrap(), scratch);
    assert_ne!(private, fixture.root.join("authorized-source.apks"));
    assert_eq!(fs::read(private).unwrap(), bytes);
    assert_eq!(
        fs::read(fixture.root.join("call-01/install-apks-input.bin")).unwrap(),
        bytes
    );
    for name in ["cwd", "TEMP", "TMP", "TMPDIR"] {
        let directory =
            fs::read_to_string(fixture.root.join(format!("call-01/{name}.txt"))).unwrap();
        assert!(Path::new(&directory).is_absolute());
        assert!(Path::new(&directory).is_dir());
        // Windows 的 current_dir 可省略 verbatim 前缀；比较真实目录而非路径拼写。
        assert_eq!(
            fs::canonicalize(&directory).unwrap(),
            fs::canonicalize(private.parent().unwrap()).unwrap()
        );
    }
    assert_eq!(
        fs::read(fixture.root.join("call-01/restricted-flags.bin")).unwrap(),
        [0; 4]
    );
    assert_eq!(
        fs::read(fixture.root.join("call-01/java-restricted-flags.bin")).unwrap(),
        [0; 3]
    );
    fixture.release(1);
    let reply = running.complete();
    probe.assert_exited();
    assert_eq!(
        success(&reply),
        &json!({"artifact_id":ARTIFACT_ID,"device_id":SERIAL,"installed":true})
    );
    assert_eq!(reply["response"].as_object().unwrap().len(), 3);
    assert!(!serde_json::to_string(&reply).unwrap().contains(&args[4]));
    assert_eq!(
        fs::read(fixture.root.join("authorized-source.apks")).unwrap(),
        bytes
    );
    assert!(!fixture.root.join("unused-output").exists());
    assert!(!private.exists());
    artifacts::empty(&scratch);
    fixture.assert_calls(1);
}

#[test]
fn apks_preserves_zero_exit_empty_ordinary_and_lossy_output_success() {
    for (stdout, stderr) in [
        (b"".as_slice(), b"".as_slice()),
        (
            b"bundle installed\n".as_slice(),
            b"ordinary notice\n".as_slice(),
        ),
        (&[0xff][..], b"".as_slice()),
        (b"".as_slice(), &[0xfe][..]),
    ] {
        let (fixture, scratch, _) = configured("apks-old-success");
        let request = apks::request(&fixture, &apks::sample());
        let reply = artifacts::run(&fixture, request, stdout, stderr, 0);
        assert_eq!(
            success(&reply),
            &json!({"artifact_id":ARTIFACT_ID,"device_id":SERIAL,"installed":true})
        );
        assert_eq!(reply["response"].as_object().unwrap().len(), 3);
        artifacts::empty(&scratch);
    }
}

#[test]
fn apks_rejects_each_old_failure_substring_in_either_stream() {
    for word in [
        "Failure",
        "FAILED",
        "error",
        "unable",
        "cannot",
        "offline",
        "unauthorized",
        "no devices",
        "incompatible",
    ] {
        for stderr in [false, true] {
            let (fixture, scratch, _) = configured("apks-old-diagnostic");
            let request = apks::request(&fixture, &apks::sample());
            let (out, err) = if stderr {
                (b"Success".as_slice(), word.as_bytes())
            } else {
                (word.as_bytes(), b"Success".as_slice())
            };
            failure(
                &artifacts::run(&fixture, request, out, err, 0),
                "工具依赖失败：APKS工具返回失败诊断",
            );
            artifacts::empty(&scratch);
        }
    }
}

#[test]
fn apks_nonzero_exit_is_fixed_failure_without_raw_diagnostic() {
    let (fixture, scratch, _) = configured("apks-nonzero");
    let request = apks::request(&fixture, &apks::sample());
    failure(
        &artifacts::run(&fixture, request, b"Success", b"private diagnostic", 7),
        "工具依赖失败：APKS工具调用失败，请检查设备、工具版本与包体兼容性",
    );
    artifacts::empty(&scratch);
}

#[test]
fn apks_each_stream_has_one_mib_limit() {
    let bytes = vec![b'a'; 1024 * 1024 + 1];
    for stderr in [false, true] {
        let (fixture, scratch, _) = configured("apks-output-limit");
        let request = apks::request(&fixture, &apks::sample());
        let (out, err) = if stderr {
            (b"".as_slice(), bytes.as_slice())
        } else {
            (bytes.as_slice(), b"".as_slice())
        };
        failure(
            &artifacts::run(&fixture, request, out, err, 0),
            "数据超过插件限额",
        );
        artifacts::empty(&scratch);
    }
}

#[test]
fn apks_missing_java_or_bundletool_is_dependency_failure_without_starting_tools() {
    for (key, expected) in [
        ("java", "工具依赖失败：部署者未配置Java入口"),
        ("bundletool", "工具依赖失败：部署者未配置bundletool JAR"),
    ] {
        let (mut fixture, scratch, _) = configured("apks-missing-deployment");
        fixture.config["tools"].as_object_mut().unwrap().remove(key);
        fixture.save_config();
        reject(
            &fixture,
            apks::request(&fixture, &apks::sample()),
            expected,
            &scratch,
        );
    }
}

#[test]
fn apks_java_and_jar_require_existing_regular_files() {
    for shape in 0..4 {
        let (mut fixture, scratch, _) = configured("apks-tool-file-qualification");
        let missing = fixture.root.join("missing-deployment-file");
        let path = if shape % 2 == 0 {
            &missing
        } else {
            &fixture.root
        };
        if shape < 2 {
            fixture.config["tools"]["java"] = json!(path);
        } else {
            fixture.config["tools"]["bundletool"]["jar"] = json!(path);
        }
        fixture.save_config();
        reject(
            &fixture,
            apks::request(&fixture, &apks::sample()),
            if shape % 2 == 0 {
                "文件操作失败：配置或工具路径无法读取"
            } else {
                "输入无效：配置或工具入口不是普通文件"
            },
            &scratch,
        );
    }
}

#[test]
fn apks_deployment_disallows_free_arguments_relative_jar_and_alternate_bundletool_shapes() {
    for shape in 0..5 {
        let (mut fixture, scratch, _) = configured("apks-strict-deployment");
        let expected = match shape {
            0 => {
                fixture.config["tools"]["java"] = json!("java -Xmx1g");
                "输入无效：Java入口须为绝对路径或单一程序名"
            }
            1 => {
                fixture.config["tools"]["bundletool"]["jar"] = json!("relative.jar");
                "输入无效：配置路径须为不含父路径的绝对路径"
            }
            2 => {
                fixture.config["tools"]["bundletool"]["args"] = json!(["--mode=universal"]);
                "输入无效：部署配置JSON无效"
            }
            3 => {
                fixture.config["tools"]["bundletool"]["kind"] = json!("executable");
                "输入无效：部署配置JSON无效"
            }
            _ => {
                fixture.config["tools"]["java"] = json!(["java"]);
                "输入无效：部署配置JSON无效"
            }
        };
        fixture.save_config();
        reject(
            &fixture,
            apks::request(&fixture, &apks::sample()),
            expected,
            &scratch,
        );
    }
}

#[test]
fn apks_requires_exact_unique_authorization_before_configuration_or_source_io() {
    for shape in 0..5 {
        let (fixture, scratch, _) = configured("apks-unique-authorization");
        let mut request = apks::request(&fixture, &apks::sample());
        let row = request["artifacts"]["inputs"][0].clone();
        let expected = match shape {
            0 => {
                request["artifacts"] = Value::Null;
                "输入无效：安装要求唯一输入产物副本"
            }
            1 => {
                request["artifacts"]["inputs"] = json!([]);
                "输入无效：安装要求唯一输入产物副本"
            }
            2 => {
                request["artifacts"]["inputs"] = json!([row.clone(), row]);
                "输入无效：安装要求唯一输入产物副本"
            }
            3 => {
                request["artifacts"]["inputs"][0]["field"] = json!("/artifact_id");
                "输入无效：安装输入产物pointer或ID不一致"
            }
            _ => {
                request["artifacts"]["inputs"][0]["artifact_id"] =
                    json!("ffffffff-ffff-ffff-ffff-ffffffffffff");
                "输入无效：安装输入产物pointer或ID不一致"
            }
        };
        fs::write(&fixture.config_path, b"must-not-read-bad-config").unwrap();
        reject(&fixture, request, expected, &scratch);
    }
}

#[test]
fn apks_rejects_wrong_extension_oversize_and_bad_sha_metadata_before_configuration() {
    for (key, value, expected) in [
        (
            "filename",
            json!("package.apk"),
            "输入无效：分包安装仅接受APKS产物",
        ),
        ("size", json!(FILE_LIMIT + 1), "数据超过插件限额"),
        (
            "sha256",
            json!("0".repeat(63)),
            "输入无效：输入产物摘要无效",
        ),
    ] {
        let (fixture, scratch, _) = configured("apks-authorized-metadata");
        let mut request = apks::request(&fixture, &apks::sample());
        request["artifacts"]["inputs"][0][key] = value;
        fs::write(&fixture.config_path, b"must-not-read-bad-config").unwrap();
        reject(&fixture, request, expected, &scratch);
    }
}

#[test]
fn apks_checks_authorized_size_and_full_sha256_before_java() {
    for (key, value, expected) in [
        ("size", json!(1), "输入无效：输入产物长度不一致"),
        (
            "sha256",
            json!("0".repeat(64)),
            "输入无效：输入产物大小或SHA256不一致",
        ),
    ] {
        let (fixture, scratch, _) = configured("apks-private-integrity");
        let mut request = apks::request(&fixture, &apks::sample());
        request["artifacts"]["inputs"][0][key] = value;
        reject(&fixture, request, expected, &scratch);
    }
}

#[test]
fn apks_accepts_exact_64_mib_and_uppercase_sha256() {
    let (fixture, scratch, _) = configured("apks-size-equal");
    let skeleton = apks::stored_zip(&[
        ("toc.pb", b"toc"),
        ("splits/base.apk", b"PK\x03\x04apk"),
        ("padding.dat", b""),
    ]);
    let padding = vec![0; FILE_LIMIT - skeleton.len()];
    let bytes = apks::stored_zip(&[
        ("toc.pb", b"toc"),
        ("splits/base.apk", b"PK\x03\x04apk"),
        ("padding.dat", &padding),
    ]);
    assert_eq!(bytes.len(), FILE_LIMIT);
    let mut request = apks::request(&fixture, &bytes);
    let uppercase = request["artifacts"]["inputs"][0]["sha256"]
        .as_str()
        .unwrap()
        .to_ascii_uppercase();
    request["artifacts"]["inputs"][0]["sha256"] = json!(uppercase);
    let reply = artifacts::run(&fixture, request, b"", b"", 0);
    assert_eq!(
        success(&reply),
        &json!({"artifact_id":ARTIFACT_ID,"device_id":SERIAL,"installed":true})
    );
    assert_eq!(
        fs::metadata(fixture.root.join("call-01/install-apks-input.bin"))
            .unwrap()
            .len(),
        FILE_LIMIT as u64
    );
    artifacts::empty(&scratch);
}

#[test]
fn apks_outer_validation_rejects_missing_toc_apk_magic_duplicates_and_unsafe_paths_before_java() {
    let mut bad_crc = apks::sample();
    // 修改内容但保留原 CRC；授权 SHA256 按修改后的真实字节计算。
    bad_crc[30 + "toc.pb".len()] ^= 1;
    let invalid = [
        b"not a ZIP".to_vec(),
        apks::stored_zip(&[("base.apk", b"PK\x03\x04apk")]),
        apks::stored_zip(&[("toc.pb", b""), ("base.apk", b"PK\x03\x04apk")]),
        apks::stored_zip(&[("toc.pb", b"toc")]),
        apks::stored_zip(&[("toc.pb", b"toc"), ("base.apk", b"bad apk magic")]),
        apks::stored_zip(&[
            ("toc.pb", b"toc"),
            ("base.apk", b"PK\x03\x04one"),
            ("base.apk", b"PK\x03\x04two"),
        ]),
        apks::stored_zip(&[("toc.pb", b"toc"), ("../base.apk", b"PK\x03\x04apk")]),
        bad_crc,
    ];
    for bytes in invalid {
        let (fixture, scratch, _) = configured("apks-invalid-outer-zip");
        reject(
            &fixture,
            apks::request(&fixture, &bytes),
            INVALID_APKS,
            &scratch,
        );
        assert_eq!(
            fs::read(fixture.root.join("authorized-source.apks")).unwrap(),
            bytes
        );
    }
}

#[test]
fn apks_member_limit_is_10000_before_java() {
    let (fixture, scratch, _) = configured("apks-entry-limit");
    let entries = vec![("entry", b"".as_slice()); 10001];
    let bytes = apks::stored_zip(&entries);
    reject(
        &fixture,
        apks::request(&fixture, &bytes),
        "输入无效：APKS成员超过10000条",
        &scratch,
    );
}

fn held(mode: &str) {
    let (fixture, scratch, _) = configured("apks-held-control");
    let request = apks::request(&fixture, &apks::sample());
    fixture.plan(1, b"", b"", 0);
    let mut running = fixture.begin_request(request);
    running.start(if mode == "deadline" {
        Duration::from_secs(5)
    } else {
        Duration::from_secs(20)
    });
    let probe = fixture.wait_tool(1);
    let private = artifacts::sole_directory(&scratch);
    assert!(private.join("input.apks").is_file());
    let expected = match mode {
        "cancel" => {
            running.cancel("cancelled");
            CANCELLED
        }
        "eof" => {
            running.eof();
            CANCELLED
        }
        _ => TOTAL_TIMEOUT,
    };
    failure(&running.complete(), expected);
    probe.assert_exited();
    fixture.assert_calls(1);
    assert!(!fixture.root.join("release-1").exists());
    assert!(!private.exists());
    artifacts::empty(&scratch);
}

#[test]
fn apks_cancel_and_eof_confirm_direct_java_exit_and_private_directory_cleanup() {
    for mode in ["cancel", "eof"] {
        held(mode);
    }
}

#[test]
fn apks_tool_capture_uses_the_original_total_deadline() {
    held("deadline");
}

#[test]
fn apks_expired_start_and_queued_cancel_are_zero_io_before_configuration() {
    for cancel in [false, true] {
        let (fixture, scratch, _) = configured("apks-zero-budget");
        let request = apks::request(&fixture, &apks::sample());
        fs::write(&fixture.config_path, b"invalid-before-start").unwrap();
        let mut running = fixture.begin_request(request);
        if cancel {
            running.send_batch(&[
                running.start_frame(Duration::from_secs(20)),
                running.cancel_frame("cancelled"),
            ]);
        } else {
            running.start(Duration::ZERO);
        }
        failure(
            &running.complete(),
            if cancel { CANCELLED } else { TOTAL_TIMEOUT },
        );
        fixture.assert_no_tool();
        artifacts::empty(&scratch);
    }
}

#[test]
fn apks_delayed_start_does_not_reset_origin_deadline() {
    let (fixture, scratch, _) = configured("apks-delayed-start");
    let mut running = fixture.begin_request(apks::request(&fixture, &apks::sample()));
    thread::sleep(Duration::from_millis(500));
    running.start(Duration::from_millis(200));
    failure(&running.complete(), TOTAL_TIMEOUT);
    fixture.assert_no_tool();
    artifacts::empty(&scratch);
}

#[test]
fn apks_business_fields_cannot_select_tools_paths_or_free_arguments() {
    for (key, value) in [
        ("java", json!("other-java")),
        ("jar", json!("other.jar")),
        ("path", json!("other.apks")),
        ("args", json!(["--mode=universal"])),
    ] {
        let (fixture, scratch, _) = configured("apks-strict-business-input");
        let mut request = apks::request(&fixture, &apks::sample());
        request["input"]["input"][key] = value;
        fs::write(&fixture.config_path, b"must-not-read-bad-config").unwrap();
        reject(
            &fixture,
            request,
            "输入无效：设备动作封套或业务字段不符合严格格式",
            &scratch,
        );
    }
}
