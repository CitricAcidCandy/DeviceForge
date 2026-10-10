#[path = "acceptance_support/stored_zip.rs"]
// 全字段布局由归档套件核对；本套件只消费字节和 payload 偏移。
#[allow(dead_code)]
mod stored_zip;

use deviceforge_android_package_core::{
    ArchiveProfile, BuildMode, Control, Error, LimitKind, ManifestData, Scheme, SdkRule,
    SignatureData, Signer, TreeProfile,
    android::{parse_manifest, parse_signature, scan_sdks, validate_apks, validate_decoded},
    archive::{Archive, tree},
};
use std::fs::{self, File};
use stored_zip::stored_zip;

const MANIFEST: &str = include_str!("acceptance_support/manifest.xml");
const SIGNATURE: &str = include_str!("acceptance_support/signature.txt");

#[test]
fn manifest_sample_preserves_all_old_business_values_and_original_text() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    assert_eq!(
        parse_manifest(MANIFEST, &control).unwrap(),
        ManifestData {
            package_name: "com.example.app".into(),
            version_code: Some("42".into()),
            version_name: Some("1 & 2".into()),
            min_sdk: Some("23".into()),
            target_sdk: Some("35".into()),
            application_label: Some("@string/app_name".into()),
            debuggable: Some(false),
            permissions: vec!["android.permission.INTERNET".into()],
            xml: MANIFEST.into(),
        }
    );
}

#[test]
fn manifest_namespace_uri_not_prefix_controls_android_fields() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let renamed = MANIFEST
        .replace("xmlns:a=", "xmlns:mobile=")
        .replace(" a:", " mobile:");
    let result = parse_manifest(&renamed, &control).unwrap();
    assert_eq!(result.version_code.as_deref(), Some("42"));
    assert_eq!(result.version_name.as_deref(), Some("1 & 2"));
    assert_eq!(result.debuggable, Some(false));
    assert_eq!(result.xml, renamed);

    let fake = "<manifest xmlns:a='urn:fake' package='example' a:versionCode='999'><application a:debuggable='true'/></manifest>";
    let result = parse_manifest(fake, &control).unwrap();
    assert_eq!(result.version_code, None);
    assert_eq!(result.debuggable, None);
    assert_eq!(result.xml, fake);
}

#[test]
fn absent_manifest_values_remain_none_and_permissions_are_sorted_unique() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let xml = "<manifest xmlns:a='http://schemas.android.com/apk/res/android' package='example'><uses-permission a:name='z.permission'/><uses-permission-sdk-23 a:name='a.permission'/><uses-permission a:name='z.permission'/></manifest>";
    let result = parse_manifest(xml, &control).unwrap();
    assert_eq!(result.version_code, None);
    assert_eq!(result.version_name, None);
    assert_eq!(result.min_sdk, None);
    assert_eq!(result.target_sdk, None);
    assert_eq!(result.application_label, None);
    assert_eq!(result.debuggable, None);
    assert_eq!(result.permissions, ["a.permission", "z.permission"]);
}

#[test]
fn ambiguous_or_unsafe_manifest_documents_have_exact_format_errors() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    for xml in [
        "<manifest package='a'/><manifest package='b'/>",
        "<application package='a'/>",
        "<manifest package='a'><uses-sdk/><uses-sdk/></manifest>",
        "<manifest package='a'><application/><application/></manifest>",
        "<!DOCTYPE manifest [<!ENTITY unsafe 'x'>]><manifest package='a'/>",
        "<manifest package='&undefined;'/>",
        "<manifest package='a' unknown:versionCode='1'/>",
        "<manifest xmlns:a='http://schemas.android.com/apk/res/android' xmlns:b='http://schemas.android.com/apk/res/android' package='a' a:versionCode='1' b:versionCode='2'/>",
    ] {
        assert!(
            matches!(
                parse_manifest(xml, &control),
                Err(Error::InvalidManifest(_))
            ),
            "样本：{xml}"
        );
    }
}

#[test]
fn manifest_text_limit_accepts_equality_and_rejects_one_extra_byte() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let prefix = "<manifest package='example'>";
    let suffix = "</manifest>";
    let equal = format!(
        "{prefix}{}{suffix}",
        " ".repeat(1024 * 1024 - prefix.len() - suffix.len())
    );
    assert_eq!(parse_manifest(&equal, &control).unwrap().xml, equal);
    let over = format!("{equal} ");
    assert!(matches!(
        parse_manifest(&over, &control),
        Err(Error::LimitExceeded {
            kind: LimitKind::TextBytes,
            limit: 1_048_576
        })
    ));
}

#[test]
fn signature_sample_and_warnings_preserve_old_values_and_report() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let report = format!("{SIGNATURE}WARNING: synthetic warning\n");
    assert_eq!(
        parse_signature(&report, &control).unwrap(),
        SignatureData {
            verified: true,
            signers: vec![Signer {
                number: 1,
                distinguished_name: Some("CN=DeviceForge Test".into()),
                certificate_sha256: "ab".repeat(32)
            }],
            schemes: vec![
                Scheme {
                    scheme: "v1".into(),
                    verified: false
                },
                Scheme {
                    scheme: "v2".into(),
                    verified: true
                },
                Scheme {
                    scheme: "v3".into(),
                    verified: false
                },
            ],
            report,
        }
    );
}

#[test]
fn signer_digest_is_required_but_distinguished_name_can_remain_none() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let report = SIGNATURE
        .replace("Signer #1 certificate DN: CN=DeviceForge Test\n", "")
        .replace("abab", "ABAB");
    let result = parse_signature(&report, &control).unwrap();
    assert_eq!(result.signers.len(), 1);
    assert_eq!(result.signers[0].distinguished_name, None);
    assert_eq!(result.signers[0].certificate_sha256, "ab".repeat(32));
    assert_eq!(result.report, report);
}

#[test]
fn incomplete_or_contradictory_signature_reports_are_rejected() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let missing_digest = SIGNATURE
        .lines()
        .filter(|line| !line.contains("SHA-256 digest"))
        .collect::<Vec<_>>()
        .join("\n");
    let variants = [
        SIGNATURE.replace("Verifies\n", ""),
        SIGNATURE.replace("v2): true", "v2): false"),
        format!("{SIGNATURE}DOES NOT VERIFY\n"),
        format!("{SIGNATURE}ERROR: synthetic failure\n"),
        format!("{SIGNATURE}Number of signers: 1\n"),
        SIGNATURE.replace("Signer #1", "Signer #2"),
        SIGNATURE.replace("Signer #1", "Signer #0"),
        SIGNATURE.replace("Signer #1", "Signer #33"),
        SIGNATURE.replace(&"ab".repeat(32), &"ag".repeat(32)),
        missing_digest,
    ];
    for report in variants {
        assert!(
            matches!(
                parse_signature(&report, &control),
                Err(Error::InvalidSignature(_))
            ),
            "报告资格变体必须精确失败"
        );
    }
}

#[test]
fn signature_text_limit_accepts_equality_and_rejects_one_extra_byte() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let equal = format!("{SIGNATURE}{}", " ".repeat(1024 * 1024 - SIGNATURE.len()));
    assert_eq!(parse_signature(&equal, &control).unwrap().report, equal);
    assert!(matches!(
        parse_signature(&format!("{equal} "), &control),
        Err(Error::LimitExceeded {
            kind: LimitKind::TextBytes,
            limit: 1_048_576
        })
    ));
}

#[test]
fn pre_cancelled_parsers_do_not_return_partially_parsed_values() {
    let cancelled = || true;
    let control = Control::new(None, &cancelled);
    assert!(matches!(
        parse_manifest(MANIFEST, &control),
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        parse_signature(SIGNATURE, &control),
        Err(Error::Cancelled)
    ));
}

fn apks_archive(temporary: &tempfile::TempDir, bytes: &[u8], control: &Control<'_>) -> Archive {
    let path = temporary.path().join("fixture.apks");
    fs::write(&path, bytes).unwrap();
    Archive::open(
        File::open(path).unwrap(),
        ArchiveProfile::Structure,
        control,
    )
    .unwrap()
}

#[test]
fn apks_modes_have_independent_counts_and_universal_requirements() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let apk = stored_zip(&[("AndroidManifest.xml", b"synthetic")]);
    let cases = [
        (
            BuildMode::Default,
            stored_zip(&[
                ("toc.pb", b"toc"),
                ("splits/base.apk", &apk.bytes),
                ("splits/extra.apk", &apk.bytes),
            ]),
            2,
            None,
        ),
        (
            BuildMode::Universal,
            stored_zip(&[("toc.pb", b"toc"), ("universal.apk", &apk.bytes)]),
            1,
            Some("universal.apk"),
        ),
    ];
    for (mode, fixture, count, universal) in cases {
        let temporary = tempfile::tempdir().unwrap();
        let mut archive = apks_archive(&temporary, &fixture.bytes, &control);
        let result = validate_apks(&mut archive, mode, &control).unwrap();
        assert_eq!(result.apk_count, count);
        assert_eq!(result.universal_entry.as_deref(), universal);
    }
}

#[test]
fn apks_validation_reads_crc_of_even_the_last_unrelated_member() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let temporary = tempfile::tempdir().unwrap();
    let apk = stored_zip(&[("AndroidManifest.xml", b"synthetic")]);
    let mut fixture = stored_zip(&[
        ("toc.pb", b"toc"),
        ("universal.apk", &apk.bytes),
        ("unrelated.txt", b"corrupt-me"),
    ]);
    fixture.bytes[fixture.members[2].payload] ^= 1;
    let mut archive = apks_archive(&temporary, &fixture.bytes, &control);
    assert!(matches!(
        validate_apks(&mut archive, BuildMode::Universal, &control),
        Err(Error::InvalidArchive(_))
    ));
}

#[test]
fn apks_business_rejections_are_separate_from_structural_open() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let apk = stored_zip(&[("AndroidManifest.xml", b"synthetic")]);
    let cases = [
        stored_zip(&[("toc.pb", b""), ("universal.apk", &apk.bytes)]),
        stored_zip(&[("universal.apk", &apk.bytes)]),
        stored_zip(&[("toc.pb", b"toc"), ("not-apk.txt", b"data")]),
        stored_zip(&[("toc.pb", b"toc"), ("universal.apk", b"not ZIP")]),
        stored_zip(&[("toc.pb", b"toc"), ("splits/base.apk", &apk.bytes)]),
        stored_zip(&[
            ("toc.pb", b"toc"),
            ("universal.apk", &apk.bytes),
            ("universal.apk", &apk.bytes),
        ]),
    ];
    for fixture in cases {
        let temporary = tempfile::tempdir().unwrap();
        let mut archive = apks_archive(&temporary, &fixture.bytes, &control);
        assert!(matches!(
            validate_apks(&mut archive, BuildMode::Universal, &control),
            Err(Error::InvalidArchive(_))
        ));
    }
}

#[test]
fn apks_outer_validation_does_not_claim_complete_inner_crc() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let temporary = tempfile::tempdir().unwrap();
    let mut apk = stored_zip(&[("AndroidManifest.xml", b"synthetic")]);
    apk.bytes[apk.members[0].payload] ^= 1;
    // 外层 CRC 对坏内层的全部原字节重新计算；只内层 CRC 坏，不能误认外层损坏。
    let fixture = stored_zip(&[("toc.pb", b"toc"), ("universal.apk", &apk.bytes)]);
    let mut archive = apks_archive(&temporary, &fixture.bytes, &control);
    let summary = validate_apks(&mut archive, BuildMode::Universal, &control).unwrap();
    assert_eq!(summary.apk_count, 1);
    assert_eq!(summary.universal_entry.as_deref(), Some("universal.apk"));
}

#[test]
fn decoded_directory_and_sdk_findings_keep_multidex_boundaries_and_optional_class() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let fixture = stored_zip(&[
        ("apktool.yml", b"synthetic"),
        ("AndroidManifest.xml", b"synthetic"),
        ("smali_classes2/com/example/Entry.smali", b"synthetic"),
        ("smali/com/example_extra/Fake.smali", b"synthetic"),
        ("smali_classes1/com/ignored/Fake.smali", b"synthetic"),
    ]);
    let temporary = tempfile::tempdir().unwrap();
    let archive = apks_archive(&temporary, &fixture.bytes, &control);
    validate_decoded(archive.directory()).unwrap();
    let rules = [
        SdkRule {
            name: "actual".into(),
            package_path: "com.example".into(),
            class_name: Some("Entry".into()),
        },
        SdkRule {
            name: "absent-class".into(),
            package_path: "com.example".into(),
            class_name: Some("Absent".into()),
        },
        SdkRule {
            name: "package-only".into(),
            package_path: "com.example".into(),
            class_name: None,
        },
        SdkRule {
            name: "adjacent-prefix".into(),
            package_path: "com.exam".into(),
            class_name: None,
        },
        SdkRule {
            name: "fake-root".into(),
            package_path: "com.ignored".into(),
            class_name: Some("Fake".into()),
        },
    ];
    let found = scan_sdks(archive.directory(), &rules, &control).unwrap();
    assert_eq!(
        found
            .iter()
            .map(|finding| &finding.rule)
            .collect::<Vec<_>>(),
        rules.iter().collect::<Vec<_>>()
    );
    assert_eq!(
        found
            .iter()
            .map(|finding| (finding.package_found, finding.class_found))
            .collect::<Vec<_>>(),
        [
            (true, Some(true)),
            (true, Some(false)),
            (true, None),
            (false, None),
            (false, Some(false)),
        ]
    );
    for finding in &found[..3] {
        assert_eq!(finding.evidence, ["smali_classes2/com/example/Entry.smali"]);
    }
    assert!(found[3].evidence.is_empty());
    assert!(found[4].evidence.is_empty());
}

#[test]
fn sdk_evidence_is_sorted_bounded_and_keeps_the_requested_detection_point() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("decoded");
    fs::create_dir_all(root.join("smali/com/example")).unwrap();
    fs::write(root.join("apktool.yml"), b"synthetic").unwrap();
    fs::write(root.join("AndroidManifest.xml"), b"synthetic").unwrap();
    for index in (0..11).rev() {
        fs::write(
            root.join(format!("smali/com/example/A{index:02}.smali")),
            b"",
        )
        .unwrap();
    }
    fs::write(root.join("smali/com/example/ZZTarget.smali"), b"").unwrap();
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let snapshot = tree::scan(&root, TreeProfile::Reverse, &control).unwrap();
    let rules = [SdkRule {
        name: "selected".into(),
        package_path: "com.example".into(),
        class_name: Some("ZZTarget".into()),
    }];
    let found = scan_sdks(snapshot.directory(), &rules, &control).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].rule, rules[0]);
    assert!(found[0].package_found);
    assert_eq!(found[0].class_found, Some(true));
    assert_eq!(found[0].evidence.len(), 10);
    assert!(
        found[0]
            .evidence
            .contains(&"smali/com/example/ZZTarget.smali".into())
    );
    assert!(found[0].evidence.windows(2).all(|pair| pair[0] < pair[1]));
}

#[test]
fn invalid_sdk_rules_and_pre_cancelled_scan_return_exact_errors() {
    let temporary = tempfile::tempdir().unwrap();
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let fixture = stored_zip(&[
        ("apktool.yml", b"synthetic"),
        ("AndroidManifest.xml", b"synthetic"),
    ]);
    let archive = apks_archive(&temporary, &fixture.bytes, &control);
    let valid = SdkRule {
        name: "valid".into(),
        package_path: "com.example".into(),
        class_name: None,
    };
    for rules in [
        Vec::new(),
        vec![valid.clone(), valid.clone()],
        vec![SdkRule {
            package_path: "com..example".into(),
            ..valid.clone()
        }],
    ] {
        assert!(matches!(
            scan_sdks(archive.directory(), &rules, &control),
            Err(Error::InvalidArgument(_))
        ));
    }
    let cancelled = || true;
    let stopped = Control::new(None, &cancelled);
    assert!(matches!(
        scan_sdks(archive.directory(), &[valid], &stopped),
        Err(Error::Cancelled)
    ));
}

#[test]
fn decoded_final_requirements_reject_missing_empty_duplicate_or_directory_members() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    for absent in ["apktool.yml", "AndroidManifest.xml"] {
        let present = if absent == "apktool.yml" {
            "AndroidManifest.xml"
        } else {
            "apktool.yml"
        };
        let fixture = stored_zip(&[(present, b"x")]);
        let temporary = tempfile::tempdir().unwrap();
        let archive = apks_archive(&temporary, &fixture.bytes, &control);
        assert!(matches!(
            validate_decoded(archive.directory()),
            Err(Error::InvalidArchive("反编译目录缺少必要成员"))
        ));
    }
    for invalid in ["apktool.yml", "AndroidManifest.xml"] {
        let other = if invalid == "apktool.yml" {
            "AndroidManifest.xml"
        } else {
            "apktool.yml"
        };
        for duplicate in [false, true] {
            let fixture = if duplicate {
                stored_zip(&[(invalid, b"x"), (invalid, b"y"), (other, b"x")])
            } else {
                stored_zip(&[(invalid, b""), (other, b"x")])
            };
            let temporary = tempfile::tempdir().unwrap();
            let archive = apks_archive(&temporary, &fixture.bytes, &control);
            assert!(matches!(
                validate_decoded(archive.directory()),
                Err(Error::InvalidArchive("反编译必要成员必须唯一且非空"))
            ));
        }
    }
    // 普通 ZIP 目录名带尾斜杠，与同名必需文件不同，只能作为缺成员分支。
    let fixture = stored_zip(&[("apktool.yml/", b""), ("AndroidManifest.xml", b"x")]);
    let temporary = tempfile::tempdir().unwrap();
    let archive = apks_archive(&temporary, &fixture.bytes, &control);
    assert!(matches!(
        validate_decoded(archive.directory()),
        Err(Error::InvalidArchive("反编译目录缺少必要成员"))
    ));
}

#[test]
fn undefined_entity_in_namespace_declaration_is_invalid_manifest() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let xml = "<manifest xmlns:a='&undeclared;' package='example' a:versionName='1'/>";
    assert!(matches!(
        parse_manifest(xml, &control),
        Err(Error::InvalidManifest(_))
    ));
}

#[test]
fn escaped_android_namespace_uri_resolves_the_same_business_attributes() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let xml = "<manifest xmlns:a='http://schemas.android.com/apk/res/andro&#105;d' package='example' a:versionCode='42' a:versionName='1 &amp; 2'><application a:label='@string/app_name' a:debuggable='false'/></manifest>";
    let result = parse_manifest(xml, &control).unwrap();
    assert_eq!(result.version_code.as_deref(), Some("42"));
    assert_eq!(result.version_name.as_deref(), Some("1 & 2"));
    assert_eq!(
        result.application_label.as_deref(),
        Some("@string/app_name")
    );
    assert_eq!(result.debuggable, Some(false));
    assert_eq!(result.xml, xml);
}

#[test]
fn equivalent_escaped_namespace_cannot_hide_duplicate_expanded_attributes() {
    let cancelled = || false;
    let control = Control::new(None, &cancelled);
    let xml = "<manifest xmlns:a='http://schemas.android.com/apk/res/andro&#105;d' xmlns:b='http://schemas.android.com/apk/res/android' package='example' a:versionName='one' b:versionName='two'/>";
    assert!(matches!(
        parse_manifest(xml, &control),
        Err(Error::InvalidManifest(_))
    ));
}
